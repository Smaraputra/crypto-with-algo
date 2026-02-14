import type mongoose from 'mongoose';
import type { TradingStyle } from '@/lib/models/signal-template';
import { CronRun, type ICronRun } from '@/lib/models/cron-run';
import { OptimizationJob } from '@/lib/models/optimization-job';
import { SignalTemplate } from '@/lib/models/signal-template';
import { getCandles, backfillCandles, getCandleRange } from '@/lib/candle-ingestion';
import { runWalkForward } from './walk-forward';
import { createTemplateVersion } from './template-versioning';
import { shouldAutoActivate, executeAutoActivation } from './auto-activation';
import { getIntervalForStyle } from './top-symbols';
import { DEFAULT_OPTIMIZATION_CONFIG } from '@/types/optimization';

export interface MonthlyOptimizationConfig {
  cronRunId: mongoose.Types.ObjectId;
  topSymbols: string[];
  months: number; // Historical data months (default 6)
  autoActivate: boolean; // Default true
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
  const { cronRunId, topSymbols, months, autoActivate } = config;

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
        stepSizeBars: DEFAULT_OPTIMIZATION_CONFIG.stepSizeBars,
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

      // Update CronRun with jobId
      await CronRun.updateOne(
        { _id: cronRunId, 'jobs.tradingStyle': tradingStyle },
        {
          $set: {
            'jobs.$.jobId': job._id,
          },
        }
      );

      // Run walk-forward optimization
      const result = await runWalkForward({
        candles,
        symbol,
        interval,
        tradingStyle,
        minTrainingBars: DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars,
        testWindowBars: DEFAULT_OPTIMIZATION_CONFIG.testWindowBars,
        stepSizeBars: DEFAULT_OPTIMIZATION_CONFIG.stepSizeBars,
        candidatesPerWindow: DEFAULT_OPTIMIZATION_CONFIG.candidatesPerWindow,
        constraintPercent: DEFAULT_OPTIMIZATION_CONFIG.constraintPercent,
        jobId: job._id,
      });

      // Get current template for thresholds
      const currentTemplate = await SignalTemplate.findOne({
        tradingStyle,
        active: true,
      });

      const thresholds = currentTemplate?.thresholds || {
        bullish: 0.6,
        bearish: -0.6,
        strong: 0.8,
      };

      // Create new template version
      const newTemplate = await createTemplateVersion(
        tradingStyle,
        result.optimizedWeights,
        thresholds,
        {
          avgSharpe: result.ensembleResults.reduce((sum, r) => sum + ((r.metrics as { sharpeRatio: number }).sharpeRatio || 0), 0) / result.ensembleResults.length,
          avgWinRate: result.ensembleResults.reduce((sum, r) => sum + ((r.metrics as { winRate: number }).winRate || 0), 0) / result.ensembleResults.length,
          totalBacktests: result.windows.length,
        }
      );

      // Update OptimizationJob with results
      await OptimizationJob.updateOne(
        { _id: job._id },
        {
          status: 'completed',
          optimizedWeights: result.optimizedWeights,
          ensembleResults: result.ensembleResults.map((r) => r._id),
          templateVersion: newTemplate.version,
          completedAt: new Date(),
        }
      );

      let activated = false;
      let activationReason = 'Auto-activation disabled';

      // Check auto-activation
      if (autoActivate) {
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
          },
        }
      );

      completedJobs++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`${tradingStyle}: ${errorMessage}`);
      failedJobs++;

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
