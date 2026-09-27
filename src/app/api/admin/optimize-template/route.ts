import { NextResponse } from 'next/server';
import { requireAdmin, adminAuthError, adminAuthStatus } from '@/lib/admin-auth';
import { connectDB } from '@/lib/mongodb';
import { OptimizationJob } from '@/lib/models/optimization-job';
import { getCandles, backfillCandles, getCandleRange } from '@/lib/candle-ingestion';
import { getHistoricalSnapshots } from '@/lib/historical-snapshots';
import { mapToSnapshotInterval, type LeanSnapshot } from '@/lib/backtest/snapshot-series';
import { getConfirmationInterval } from '@/lib/signals/htf';
import { intervalToMs } from '@/lib/intervals';
import type { OHLCV } from '@/types/market';
import { runWalkForward } from '@/lib/optimization/walk-forward';
import { createTemplateVersion, markResultsAsContributors } from '@/lib/optimization/template-versioning';
import { passesSaveGate } from '@/lib/optimization/save-gate';
import { DEFAULT_TEMPLATE_THRESHOLDS, type TradingStyle } from '@/lib/models/signal-template';
import { DEFAULT_OPTIMIZATION_CONFIG } from '@/types/optimization';
import { z } from 'zod';

const requestSchema = z.object({
  tradingStyle: z.enum(['scalping', 'day_trading', 'swing_trading', 'position_trading']),
  symbol: z.string().min(1),
  interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']),
  months: z.number().min(1).max(12),
});

export async function POST(req: Request) {
  try {
    // 1. Auth: Admin-only
    const admin = await requireAdmin();
    if (!admin.ok) {
      return NextResponse.json(adminAuthError(admin), { status: adminAuthStatus(admin) });
    }

    // 2. Parse and validate request
    const body = await req.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const { tradingStyle, symbol, interval, months } = parsed.data;

    await connectDB();

    // 3. Fetch historical candles from stored data (backfill if needed)
    const endTime = Date.now();
    const startTime = endTime - months * 30 * 24 * 60 * 60 * 1000; // Approximate months

    // Ensure we have sufficient stored data
    const range = await getCandleRange(symbol, interval);
    const needsBackfill = !range.oldest || range.oldest > startTime || range.newest! < endTime - 60000;
    if (needsBackfill) {
      await backfillCandles(symbol, interval, months);
    }

    const candles = await getCandles(symbol, interval, startTime, endTime, 50000);

    if (candles.length < DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars + DEFAULT_OPTIMIZATION_CONFIG.testWindowBars) {
      return NextResponse.json(
        {
          error: 'Insufficient data',
          message: `Need at least ${DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars + DEFAULT_OPTIMIZATION_CONFIG.testWindowBars} candles, got ${candles.length}`,
        },
        { status: 400 }
      );
    }

    // 4. Create optimization job
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
      status: 'pending',
    });

    // 5. Update job status to running
    job.status = 'running';
    job.startedAt = new Date();
    await job.save();

    // Point-in-time futures/sentiment for the same range; zero snapshots
    // degrades to null-scored categories, matching pre-parity behavior
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
    const htfInterval = getConfirmationInterval(interval, tradingStyle as TradingStyle);
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

    try {
      // 6. Run walk-forward optimization
      const result = await runWalkForward({
        candles,
        symbol,
        interval,
        tradingStyle: tradingStyle as TradingStyle,
        snapshots,
        htfCandles,
        htfInterval: htfInterval ?? undefined,
        minTrainingBars: DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars,
        testWindowBars: DEFAULT_OPTIMIZATION_CONFIG.testWindowBars,
        stepSizeBars: DEFAULT_OPTIMIZATION_CONFIG.stepSizeBars,
        candidatesPerWindow: DEFAULT_OPTIMIZATION_CONFIG.candidatesPerWindow,
        constraintPercent: DEFAULT_OPTIMIZATION_CONFIG.constraintPercent,
        jobId: job._id,
      });

      // 7. Only the top-five ensemble documents survive a walk-forward run,
      // so whether the optimization was actually profitable out of sample
      // can only be answered from the windows themselves. The save gate
      // refuses a template when too few windows contributed, or their
      // out-of-sample expectancy is negative (session 04 handover).
      const gate = passesSaveGate(result.windows);

      const thresholds = DEFAULT_TEMPLATE_THRESHOLDS[tradingStyle as TradingStyle];
      const ensembleCount = result.ensembleResults.length;
      const avgSharpe =
        ensembleCount > 0
          ? result.ensembleResults.reduce(
              (sum, r) => sum + ((r.metrics as { sharpeRatio?: number }).sharpeRatio ?? 0),
              0
            ) / ensembleCount
          : 0;

      const avgWinRate =
        ensembleCount > 0
          ? result.ensembleResults.reduce(
              (sum, r) => sum + ((r.metrics as { winRate?: number }).winRate ?? 0),
              0
            ) / ensembleCount
          : 0;

      let template: Awaited<ReturnType<typeof createTemplateVersion>> | null = null;
      const contributorIds = result.ensembleResults.map((r) => r._id);

      if (gate.pass) {
        // Defensive: the save gate already refuses whenever no window
        // contributed (which is exactly when optimizedWeights is null), so
        // this should be unreachable. Refuse loudly rather than saving a
        // template against default weights if that invariant ever breaks.
        if (!result.optimizedWeights) {
          throw new Error('save gate passed without an ensemble; refusing to save default weights as optimized');
        }

        // 8. Create new template version (inactive by default). Not
        // ensembleCount: only the top-five ensemble documents survive a
        // walk-forward run, so a style with more than five contributing
        // windows would under-report how many out-of-sample tests actually
        // ran. gate.contributingWindows counts every window that produced
        // an out-of-sample result, matching what the monthly orchestrator
        // writes for the same field.
        template = await createTemplateVersion(
          tradingStyle as TradingStyle,
          result.optimizedWeights,
          thresholds,
          {
            avgSharpe,
            avgWinRate,
            totalBacktests: gate.contributingWindows,
          }
        );

        // 9. Mark results as contributors
        await markResultsAsContributors(contributorIds);
        job.templateVersion = template.version;
      }

      // 10. Update job with results. A refused save is a valid outcome, not
      // an error, so the job still completes.
      job.status = 'completed';
      job.completedAt = new Date();
      job.optimizedWeights = result.optimizedWeights;
      job.ensembleResults = contributorIds;
      job.windows = result.windows;
      await job.save();

      // 11. Return results
      return NextResponse.json({
        jobId: job._id.toString(),
        status: 'completed',
        optimizedWeights: result.optimizedWeights,
        templateVersion: template ? template.version : null,
        templateId: template ? template._id.toString() : null,
        performance: {
          avgSharpe,
          avgWinRate,
          totalBacktests: gate.contributingWindows,
        },
        windows: result.windows.length,
        candidatesTested: job.progress.candidatesTested,
        validResults: job.progress.validResults,
        gate,
      });
    } catch (error) {
      // Update job with error
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Unknown error';
      job.completedAt = new Date();
      await job.save();

      throw error;
    }
  } catch (error) {
    console.error('Optimization error:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
