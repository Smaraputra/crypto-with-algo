import type mongoose from 'mongoose';
import type { TradingStyle } from '@/lib/models/signal-template';
import { CronRun, type ICronRun } from '@/lib/models/cron-run';
import { OptimizationJob } from '@/lib/models/optimization-job';
import { DEFAULT_TEMPLATE_THRESHOLDS } from '@/lib/models/signal-template';
import { getCandles, backfillCandles, getCandleRange } from '@/lib/candle-ingestion';
import { getHistoricalSnapshots } from '@/lib/historical-snapshots';
import { mapToSnapshotInterval, type LeanSnapshot } from '@/lib/backtest/snapshot-series';
import { getConfirmationInterval } from '@/lib/signals/htf';
import { intervalToMs } from '@/lib/intervals';
import type { OHLCV } from '@/types/market';
import { runWalkForward, deriveStepSize } from './walk-forward';
import { createTemplateVersion, markResultsAsContributors } from './template-versioning';
import { passesSaveGate } from './save-gate';
import { shouldAutoActivate, executeAutoActivation } from './auto-activation';
import { getIntervalForStyle, getMonthsForStyle } from './top-symbols';
import { DEFAULT_OPTIMIZATION_CONFIG } from '@/types/optimization';

export interface MonthlyOptimizationConfig {
  cronRunId: mongoose.Types.ObjectId;
  topSymbols: string[];
  /**
   * Override the historical window for every style. Omit to use each style's
   * own window from getMonthsForStyle, which is the correct default: one shared
   * value cannot serve both a 5m and a 1d series.
   */
  months?: number;
  autoActivate: boolean;
}

export interface MonthlyOptimizationResult {
  cronRun: ICronRun;
  completedJobs: number;
  failedJobs: number;
  activatedTemplates: number;
  errors: string[];
}

const TRADING_STYLES: TradingStyle[] = [
  'scalping',
  'day_trading',
  'swing_trading',
  'position_trading',
];

/**
 * Orchestrate monthly optimization for all trading styles
 * Runs sequentially to avoid resource contention
 */
export async function runMonthlyOptimization(
  config: MonthlyOptimizationConfig
): Promise<MonthlyOptimizationResult> {
  const { cronRunId, topSymbols, months: monthsOverride, autoActivate } = config;

  // Update CronRun status to running
  await CronRun.updateOne({ _id: cronRunId }, { status: 'running', startedAt: new Date() });

  const errors: string[] = [];
  let completedJobs = 0;
  let failedJobs = 0;
  let activatedTemplates = 0;

  // Process each trading style sequentially
  for (let i = 0; i < TRADING_STYLES.length; i++) {
    const tradingStyle = TRADING_STYLES[i];
    const symbol = topSymbols[i % topSymbols.length]; // Round-robin symbol selection
    const interval = getIntervalForStyle(tradingStyle);
    const months = monthsOverride ?? getMonthsForStyle(tradingStyle);

    // Declared outside try so a failure can close the job it opened; otherwise
    // the job document stays 'running' forever after the run has failed.
    let jobId: mongoose.Types.ObjectId | undefined;

    try {
      // Update job status to running
      await CronRun.updateOne(
        { _id: cronRunId, 'jobs.tradingStyle': tradingStyle },
        {
          $set: {
            'jobs.$.status': 'running',
            'jobs.$.symbol': symbol,
            'jobs.$.interval': interval,
            'jobs.$.startedAt': new Date(),
          },
        }
      );

      // Fetch historical candles from stored data (backfill if needed)
      const endTime = Date.now();
      const startTime = endTime - months * 30 * 24 * 60 * 60 * 1000; // Approximate months

      // Ensure we have sufficient stored data
      const range = await getCandleRange(symbol, interval);
      const needsBackfill = !range.oldest || range.oldest > startTime || !range.newest || range.newest < endTime - 60000;
      if (needsBackfill) {
        await backfillCandles(symbol, interval, months);
      }

      const candles = await getCandles(symbol, interval, startTime, endTime, 50000);

      if (candles.length < DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars + DEFAULT_OPTIMIZATION_CONFIG.testWindowBars) {
        throw new Error(`Insufficient data: ${candles.length} bars (need ${DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars + DEFAULT_OPTIMIZATION_CONFIG.testWindowBars})`);
      }

      // Step size scales with series length so the window count stays bounded
      // whether this style trades 5m or 1d bars.
      const stepSizeBars = deriveStepSize(
        candles.length,
        DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars,
        DEFAULT_OPTIMIZATION_CONFIG.testWindowBars,
        DEFAULT_OPTIMIZATION_CONFIG.targetWindows
      );

      // Create OptimizationJob
      const job = await OptimizationJob.create({
        tradingStyle,
        symbol,
        interval,
        startTime: candles[0].timestamp,
        endTime: candles[candles.length - 1].timestamp,
        totalBars: candles.length,
        minTrainingBars: DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars,
        testWindowBars: DEFAULT_OPTIMIZATION_CONFIG.testWindowBars,
        stepSizeBars,
        candidatesPerWindow: DEFAULT_OPTIMIZATION_CONFIG.candidatesPerWindow,
        constraintPercent: DEFAULT_OPTIMIZATION_CONFIG.constraintPercent,
        status: 'running',
        progress: {
          currentWindow: 0,
          totalWindows: 0,
          candidatesTested: 0,
          validResults: 0,
        },
        startedAt: new Date(),
      });
      jobId = job._id;

      // Update CronRun with jobId
      await CronRun.updateOne(
        { _id: cronRunId, 'jobs.tradingStyle': tradingStyle },
        {
          $set: {
            'jobs.$.jobId': job._id,
          },
        }
      );

      // Point-in-time futures/sentiment for the same range (8h margin covers
      // the funding cadence); zero snapshots degrades to null-scored categories
      let snapshots: LeanSnapshot[] = [];
      try {
        snapshots = await getHistoricalSnapshots(
          symbol,
          mapToSnapshotInterval(interval),
          startTime - 8 * 60 * 60 * 1000,
          endTime
        );
      } catch (error) {
        console.error(`Failed to fetch snapshots for ${symbol}:`, error instanceof Error ? error.message : 'Unknown error');
      }

      // Confirmation-timeframe candles for MTF confluence (250-bar warmup margin)
      let htfCandles: OHLCV[] = [];
      const htfInterval = getConfirmationInterval(interval, tradingStyle);
      if (htfInterval) {
        try {
          const htfStart = startTime - 250 * intervalToMs(htfInterval);
          const htfRange = await getCandleRange(symbol, htfInterval);
          if (!htfRange.oldest || htfRange.oldest > htfStart) {
            await backfillCandles(symbol, htfInterval, months + 2);
          }
          htfCandles = await getCandles(symbol, htfInterval, htfStart, endTime, 50000);
        } catch (error) {
          console.error(`Failed to fetch HTF candles for ${symbol}:`, error instanceof Error ? error.message : 'Unknown error');
        }
      }

      // Run walk-forward optimization
      const result = await runWalkForward({
        candles,
        symbol,
        interval,
        tradingStyle,
        snapshots,
        htfCandles,
        htfInterval: htfInterval ?? undefined,
        minTrainingBars: DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars,
        testWindowBars: DEFAULT_OPTIMIZATION_CONFIG.testWindowBars,
        stepSizeBars,
        candidatesPerWindow: DEFAULT_OPTIMIZATION_CONFIG.candidatesPerWindow,
        constraintPercent: DEFAULT_OPTIMIZATION_CONFIG.constraintPercent,
        jobId: job._id,
      });

      // Only the top-five ensemble documents survive a walk-forward run, so
      // whether the optimization was actually profitable out of sample can
      // only be answered from the windows themselves. Refusing to save a
      // template when too few windows contributed, or their out-of-sample
      // expectancy is negative, is the session 04 handover's fix for the
      // first two templates ever created (each saved from a single
      // contributing window with negative out-of-sample results).
      const gate = passesSaveGate(result.windows);

      let newTemplate: Awaited<ReturnType<typeof createTemplateVersion>> | null = null;

      if (gate.pass) {
        // Defensive: the save gate already refuses whenever no window
        // contributed (which is exactly when optimizedWeights is null), so
        // this should be unreachable. Refuse loudly rather than saving a
        // template against default weights if that invariant ever breaks.
        if (!result.optimizedWeights) {
          throw new Error('save gate passed without an ensemble; refusing to save default weights as optimized');
        }

        // The template stores the thresholds its weights were optimized
        // against. Walk-forward always backtests with the style defaults, so
        // borrowing an active template's thresholds could pair weights with
        // levels they were never tested on. The previous fallback used an
        // obsolete shape ({ bullish, bearish, strong }) that fails schema
        // validation, so the first styles ever to pass walk-forward failed at
        // this step instead.
        const thresholds = { ...DEFAULT_TEMPLATE_THRESHOLDS[tradingStyle] };
        const ensembleCount = result.ensembleResults.length;

        newTemplate = await createTemplateVersion(
          tradingStyle,
          result.optimizedWeights,
          thresholds,
          {
            avgSharpe:
              ensembleCount > 0
                ? result.ensembleResults.reduce((sum, r) => sum + ((r.metrics as { sharpeRatio: number }).sharpeRatio || 0), 0) / ensembleCount
                : 0,
            avgWinRate:
              ensembleCount > 0
                ? result.ensembleResults.reduce((sum, r) => sum + ((r.metrics as { winRate: number }).winRate || 0), 0) / ensembleCount
                : 0,
            // Not result.windows.length: that now includes windows skipped
            // for lacking a robust in-sample candidate, which never ran an
            // out-of-sample test. gate.contributingWindows counts only
            // windows that actually did.
            totalBacktests: gate.contributingWindows,
          }
        );

        // Mark out-of-sample contributors so provenance is queryable
        await markResultsAsContributors(
          result.ensembleResults.map((r) => r._id as mongoose.Types.ObjectId)
        );
      }

      // Update OptimizationJob with results. A refused save is a valid
      // outcome, not an error, so the job still completes.
      await OptimizationJob.updateOne(
        { _id: job._id },
        {
          status: 'completed',
          optimizedWeights: result.optimizedWeights,
          ensembleResults: result.ensembleResults.map((r) => r._id),
          windows: result.windows,
          templateVersion: newTemplate ? newTemplate.version : null,
          completedAt: new Date(),
        }
      );

      let activated = false;
      let activationReason = gate.pass
        ? 'Auto-activation disabled'
        : `Template not saved: ${gate.reason}`;

      // Check auto-activation (only meaningful when a template was saved)
      if (gate.pass && newTemplate && autoActivate) {
        const decision = await shouldAutoActivate(tradingStyle, newTemplate);
        activationReason = decision.reason;

        if (decision.shouldActivate) {
          await executeAutoActivation(newTemplate._id as mongoose.Types.ObjectId, decision);
          activated = true;
          activatedTemplates++;
        }
      }

      // Update CronRun job status to completed
      await CronRun.updateOne(
        { _id: cronRunId, 'jobs.tradingStyle': tradingStyle },
        {
          $set: {
            'jobs.$.status': 'completed',
            'jobs.$.completedAt': new Date(),
            'jobs.$.activated': activated,
            'jobs.$.activationReason': activationReason,
            'jobs.$.gateReason': gate.reason,
          },
        }
      );

      completedJobs++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`${tradingStyle}: ${errorMessage}`);
      failedJobs++;

      if (jobId) {
        await OptimizationJob.updateOne(
          { _id: jobId },
          { $set: { status: 'failed', error: errorMessage, completedAt: new Date() } }
        );
      }

      // Update CronRun job status to failed
      await CronRun.updateOne(
        { _id: cronRunId, 'jobs.tradingStyle': tradingStyle },
        {
          $set: {
            'jobs.$.status': 'failed',
            'jobs.$.completedAt': new Date(),
            'jobs.$.error': errorMessage,
          },
        }
      );

      // Continue to next trading style (don't throw)
      console.error(`Error optimizing ${tradingStyle}:`, error);
    }
  }

  // Update CronRun summary and status
  await CronRun.updateOne(
    { _id: cronRunId },
    {
      status: failedJobs === TRADING_STYLES.length ? 'failed' : 'completed',
      completedAt: new Date(),
      summary: {
        totalJobs: TRADING_STYLES.length,
        completedJobs,
        failedJobs,
        activatedTemplates,
      },
      error: errors.length > 0 ? errors.join('; ') : null,
    }
  );

  const cronRun = await CronRun.findById(cronRunId);
  if (!cronRun) {
    throw new Error('CronRun not found after completion');
  }

  return {
    cronRun,
    completedJobs,
    failedJobs,
    activatedTemplates,
    errors,
  };
}
