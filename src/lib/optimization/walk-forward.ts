import type { OHLCV } from '@/types/market';
import type { TradingStyle } from '@/lib/models/signal-template';
import type { SignalWeights } from '@/types/signal';
import type { WalkForwardWindow } from '@/types/optimization';
import type { BacktestConfig } from '@/lib/backtest/types';
import { BacktestResultV2, type IBacktestResultV2 } from '@/lib/models/backtest-result-v2';
import { OptimizationJob } from '@/lib/models/optimization-job';
import { DEFAULT_TEMPLATE_WEIGHTS, DEFAULT_TEMPLATE_THRESHOLDS } from '@/lib/models/signal-template';
import { prepareBacktest, runOptimizedBacktest } from '@/lib/backtest/optimized-engine';
import { computeMinCandles } from '@/lib/indicators/compute';
import type { LeanSnapshot } from '@/lib/backtest/snapshot-series';
import { generateWeightCandidates } from './weight-generator';
import { filterRobustResults } from './robustness-filter';
import { createEnsemble } from './ensemble';
import { compressBacktestResult } from '@/lib/backtest/compress-results';
import { DEFAULT_ROBUSTNESS, type RobustnessConfig } from '@/types/optimization';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import mongoose from 'mongoose';

export interface WalkForwardConfig {
  candles: OHLCV[];
  symbol: string;
  interval: string;
  tradingStyle: TradingStyle;

  minTrainingBars: number;
  testWindowBars: number;
  stepSizeBars: number;
  candidatesPerWindow: number;
  constraintPercent: number;

  jobId: mongoose.Types.ObjectId; // For progress updates

  snapshots?: LeanSnapshot[]; // point-in-time futures/sentiment for the candle range
  robustness?: RobustnessConfig;
  htfCandles?: OHLCV[]; // confirmation-timeframe candles (with warmup margin)
  htfInterval?: string;
}

export interface WalkForwardResult {
  optimizedWeights: SignalWeights;
  ensembleResults: IBacktestResultV2[];
  windows: WalkForwardWindow[];
}

/**
 * Run walk-forward optimization
 * Uses anchored expanding window approach
 */
export async function runWalkForward(config: WalkForwardConfig): Promise<WalkForwardResult> {
  const {
    candles,
    symbol,
    interval,
    tradingStyle,
    minTrainingBars,
    testWindowBars,
    stepSizeBars,
    candidatesPerWindow,
    constraintPercent,
    jobId,
    snapshots,
    robustness = DEFAULT_ROBUSTNESS,
    htfCandles,
    htfInterval,
  } = config;

  // Per-LTF-bar alignment inside the engines is closed-bar-only and the HTF
  // series is causal, so passing the full HTF array to every window slice
  // cannot leak future bars
  const htfInput =
    htfCandles && htfCandles.length > 0 && htfInterval
      ? { candles: htfCandles, interval: htfInterval }
      : undefined;

  // Get base template weights and style-specific indicator config
  const baseWeights = DEFAULT_TEMPLATE_WEIGHTS[tradingStyle];
  const thresholds = DEFAULT_TEMPLATE_THRESHOLDS[tradingStyle];
  const styleProfile = getStyleConfig(tradingStyle);
  const indicatorConfig = styleProfile.config;

  // A training window must satisfy the style's indicator warmup, or
  // computeAllIndicators throws on the slice
  const effectiveMinTrainingBars = Math.max(
    minTrainingBars,
    computeMinCandles(indicatorConfig) + 10
  );

  // Calculate walk-forward windows
  const windows = calculateWindows(
    candles.length,
    effectiveMinTrainingBars,
    testWindowBars,
    stepSizeBars
  );

  // Update job with total windows
  await OptimizationJob.updateOne(
    { _id: jobId },
    { $set: { 'progress.totalWindows': windows.length } }
  );

  const windowResults: WalkForwardWindow[] = [];
  const oosDocs: IBacktestResultV2[] = []; // index-aligned with windowResults
  let totalCandidatesTested = 0;
  let totalValidResults = 0;

  // Process each window
  for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
    const window = windows[windowIndex];

    // 1. Extract training data
    const trainingCandles = candles.slice(window.trainStart, window.trainEnd + 1);

    // 2. Prepare backtest (compute indicators once with style-specific params).
    // The snapshot series is timestamp-aligned, so passing the full snapshot
    // list against the sliced candles keeps windows point-in-time correct.
    const prepared = prepareBacktest(
      trainingCandles,
      symbol,
      interval,
      indicatorConfig,
      snapshots,
      htfInput
    );

    // 3. Generate weight candidates
    const candidates = generateWeightCandidates(
      baseWeights,
      candidatesPerWindow,
      constraintPercent,
      windowIndex + 42 // Unique seed per window
    );

    // 4. Test each candidate on training data
    const candidateResults: IBacktestResultV2[] = [];
    for (const candidateWeights of candidates) {
      // Create backtest config with candidate weights
      const btConfig: BacktestConfig = {
        weights: candidateWeights,
        entryThreshold: thresholds.entryThreshold,
        exitThreshold: thresholds.exitThreshold,
        shortEntryThreshold: thresholds.shortEntryThreshold,
        shortExitThreshold: thresholds.shortExitThreshold,
        allowShorts: true,
        positionSizing: {
          method: 'risk_based',
          riskPerTrade: 0.01,
        },
        positionSizePercent: 0.1,
        stopLossPercent: 0.03,
        takeProfitPercent: 0.06,
        feePercent: 0.001,
        startEquity: 10000,
      };

      // Run optimized backtest
      const result = runOptimizedBacktest(prepared, btConfig, symbol, interval);

      // Compress and store result
      const compressed = compressBacktestResult(
        result,
        'system', // System-generated
        null, // No strategy ID
        tradingStyle,
        null, // No template yet
        1, // Optimization generation 1
        null
      );

      // Save to database
      const doc = await BacktestResultV2.create(compressed);
      candidateResults.push(doc);

      totalCandidatesTested++;
    }

    // 5. Filter by robustness (in-sample filtering)
    const robustCandidates = filterRobustResults(candidateResults, robustness);
    totalValidResults += robustCandidates.length;

    // 6. Select best candidate by Sharpe ratio
    if (robustCandidates.length === 0) {
      // No robust candidates found, skip this window
      await OptimizationJob.updateOne(
        { _id: jobId },
        {
          $set: {
            'progress.currentWindow': windowIndex + 1,
            'progress.candidatesTested': totalCandidatesTested,
            'progress.validResults': totalValidResults,
          },
        }
      );
      continue;
    }

    const bestCandidate = robustCandidates.reduce((best, curr) => {
      const bestSharpe = (best.metrics as { sharpeRatio?: number }).sharpeRatio ?? -Infinity;
      const currSharpe = (curr.metrics as { sharpeRatio?: number }).sharpeRatio ?? -Infinity;
      return currSharpe > bestSharpe ? curr : best;
    }, robustCandidates[0]);

    const bestWeights = (bestCandidate.config as { weights: SignalWeights }).weights;

    // 7. Validate on test window (out-of-sample). The slice is prefixed with
    // exactly the indicator warmup (a data-independent constant for a given
    // config, known from the training prepare), so the engine's first traded
    // bar is window.testStart and no in-sample bar is traded.
    const warmupPrefix = prepared.warmupBars;
    const testSliceStart = Math.max(0, window.testStart - warmupPrefix);
    const testCandles = candles.slice(testSliceStart, window.testEnd + 1);
    const testPrepared = prepareBacktest(
      testCandles,
      symbol,
      interval,
      indicatorConfig,
      snapshots,
      htfInput
    );

    const testConfig: BacktestConfig = {
      weights: bestWeights,
      entryThreshold: thresholds.entryThreshold,
      exitThreshold: thresholds.exitThreshold,
      shortEntryThreshold: thresholds.shortEntryThreshold,
      shortExitThreshold: thresholds.shortExitThreshold,
      allowShorts: true,
      positionSizing: {
        method: 'risk_based',
        riskPerTrade: 0.01,
      },
      positionSizePercent: 0.1,
      stopLossPercent: 0.03,
      takeProfitPercent: 0.06,
      feePercent: 0.001,
      startEquity: 10000,
    };

    const testResult = runOptimizedBacktest(testPrepared, testConfig, symbol, interval);
    const testSharpe = (testResult.metrics.sharpeRatio as number) ?? 0;

    // Save test result
    const testCompressed = compressBacktestResult(
      testResult,
      'system',
      null,
      tradingStyle,
      null,
      1,
      bestCandidate._id.toString()
    );
    const testDoc = await BacktestResultV2.create(testCompressed);
    oosDocs.push(testDoc);

    // 8. Store window result
    windowResults.push({
      trainStart: window.trainStart,
      trainEnd: window.trainEnd,
      testStart: window.testStart,
      testEnd: window.testEnd,
      bestWeights,
      testSharpe,
      testResultId: String(testDoc._id),
    });

    // 9. Update job progress
    await OptimizationJob.updateOne(
      { _id: jobId },
      {
        $set: {
          'progress.currentWindow': windowIndex + 1,
          'progress.candidatesTested': totalCandidatesTested,
          'progress.validResults': totalValidResults,
        },
      }
    );
  }

  // 10. Create ensemble from top 5 windows by test Sharpe, using the
  // out-of-sample test docs captured per window (never in-sample candidates)
  const ensembleResultDocs = windowResults
    .map((window, i) => ({ testSharpe: window.testSharpe, doc: oosDocs[i] }))
    .sort((a, b) => b.testSharpe - a.testSharpe)
    .slice(0, 5)
    .map((entry) => entry.doc);

  const ensemble = createEnsemble(ensembleResultDocs, 5);

  return {
    optimizedWeights: ensemble.weights,
    ensembleResults: ensemble.contributors,
    windows: windowResults,
  };
}

/**
 * Calculate walk-forward windows (anchored expanding)
 */
export function calculateWindows(
  totalBars: number,
  minTrainingBars: number,
  testWindowBars: number,
  stepSizeBars: number
): Array<{ trainStart: number; trainEnd: number; testStart: number; testEnd: number }> {
  const windows: Array<{
    trainStart: number;
    trainEnd: number;
    testStart: number;
    testEnd: number;
  }> = [];

  let trainEnd = minTrainingBars - 1;

  while (trainEnd + testWindowBars < totalBars) {
    const trainStart = 0; // Anchored at start
    const testStart = trainEnd + 1;
    const testEnd = Math.min(testStart + testWindowBars - 1, totalBars - 1);

    windows.push({
      trainStart,
      trainEnd,
      testStart,
      testEnd,
    });

    // Expand training window by step size
    trainEnd += stepSizeBars;
  }

  return windows;
}
