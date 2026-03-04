import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { OptimizationJob } from '@/lib/models/optimization-job';
import { getCandles, backfillCandles, getCandleRange } from '@/lib/candle-ingestion';
import { runWalkForward } from '@/lib/optimization/walk-forward';
import { createTemplateVersion, markResultsAsContributors } from '@/lib/optimization/template-versioning';
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
    const session = await auth();
    if (!session?.user?.email || session.user.email !== process.env.ADMIN_EMAIL) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

    try {
      // 6. Run walk-forward optimization
      const result = await runWalkForward({
        candles,
        symbol,
        interval,
        tradingStyle: tradingStyle as TradingStyle,
        minTrainingBars: DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars,
        testWindowBars: DEFAULT_OPTIMIZATION_CONFIG.testWindowBars,
        stepSizeBars: DEFAULT_OPTIMIZATION_CONFIG.stepSizeBars,
        candidatesPerWindow: DEFAULT_OPTIMIZATION_CONFIG.candidatesPerWindow,
        constraintPercent: DEFAULT_OPTIMIZATION_CONFIG.constraintPercent,
        jobId: job._id,
      });

      // 7. Create new template version (inactive by default)
      const thresholds = DEFAULT_TEMPLATE_THRESHOLDS[tradingStyle as TradingStyle];
      const avgSharpe =
        result.ensembleResults.reduce(
          (sum, r) => sum + ((r.metrics as { sharpeRatio?: number }).sharpeRatio ?? 0),
          0
        ) / result.ensembleResults.length;

      const avgWinRate =
        result.ensembleResults.reduce(
          (sum, r) => sum + ((r.metrics as { winRate?: number }).winRate ?? 0),
          0
        ) / result.ensembleResults.length;

      const template = await createTemplateVersion(
        tradingStyle as TradingStyle,
        result.optimizedWeights,
        thresholds,
        {
          avgSharpe,
          avgWinRate,
          totalBacktests: result.ensembleResults.length,
        }
      );

      // 8. Mark results as contributors
      const contributorIds = result.ensembleResults.map((r) => r._id);
      await markResultsAsContributors(contributorIds);

      // 9. Update job with results
      job.status = 'completed';
      job.completedAt = new Date();
      job.optimizedWeights = result.optimizedWeights;
      job.ensembleResults = contributorIds;
      job.templateVersion = template.version;
      await job.save();

      // 10. Return results
      return NextResponse.json({
        jobId: job._id.toString(),
        status: 'completed',
        optimizedWeights: result.optimizedWeights,
        templateVersion: template.version,
        templateId: template._id.toString(),
        performance: {
          avgSharpe,
          avgWinRate,
          totalBacktests: result.ensembleResults.length,
        },
        windows: result.windows.length,
        candidatesTested: job.progress.candidatesTested,
        validResults: job.progress.validResults,
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
