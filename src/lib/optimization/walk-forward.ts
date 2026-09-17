import type { OHLCV } from '@/types/market';
import type { TradingStyle } from '@/lib/models/signal-template';
import type { SignalWeights } from '@/types/signal';
import type { WalkForwardWindow } from '@/types/optimization';
import type { BacktestConfig } from '@/lib/backtest/types';
import { BacktestResultV2, type IBacktestResultV2 } from '@/lib/models/backtest-result-v2';
import { OptimizationJob } from '@/lib/models/optimization-job';
import { DEFAULT_TEMPLATE_WEIGHTS, DEFAULT_TEMPLATE_THRESHOLDS } from '@/lib/models/signal-template';
import { prepareBacktest, runOptimizedBacktest } from '@/lib/backtest/optimized-engine';
import { computeMinCandles, computeAllIndicators } from '@/lib/indicators/compute';
import { computeWarmupBars } from '@/lib/indicators/interpret-at-bar';
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

  // Bars skipped between training end and test start, so indicator state and
  // autocorrelated volatility from training cannot leak into the test window.
  // Defaults to the style/interval indicator warmup when omitted.
  purgeGapBars?: number;
  // 'anchored' (default) keeps trainStart at 0; 'rolling' keeps a fixed
  // training width, sliding trainStart forward with trainEnd.
  windowMode?: 'anchored' | 'rolling';
  // Training width for 'rolling' mode; defaults to minTrainingBars.
  rollingTrainBars?: number;

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
 * Run walk-forward optimization.
 *
 * Windows default to an anchored expanding training set, purged from the
 * test window by the style's own indicator warmup. Pass windowMode: 'rolling'
 * (with an optional rollingTrainBars) for a fixed-width sliding training
 * window instead. See calculateWindows for the exact window math.
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
    purgeGapBars,
    windowMode,
    rollingTrainBars,
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

  // The purge gap defaults to the style's own indicator warmup -- the same
  // computeAllIndicators + computeWarmupBars pair prepareBacktest uses --
  // measured on a training-sized slice so it matches what each window's own
  // prepareBacktest call will see.
  const resolvedPurgeGapBars =
    purgeGapBars ??
    computeWarmupBars(
      computeAllIndicators(
        candles.slice(0, effectiveMinTrainingBars),
        symbol,
        interval,
        indicatorConfig
      )
    );

  // Rolling mode's training width must also satisfy the style's indicator
  // warmup, or prepareBacktest throws on every window's too-short training
  // slice. Floor it the same way minTrainingBars is floored above, and warn
  // only when that floor actually overrides what the caller asked for.
  const resolvedRollingTrainBars = Math.max(
    rollingTrainBars ?? effectiveMinTrainingBars,
    effectiveMinTrainingBars
  );
  if (rollingTrainBars !== undefined && resolvedRollingTrainBars !== rollingTrainBars) {
    console.warn(
      `walk-forward: rollingTrainBars ${rollingTrainBars} is below the ${tradingStyle}/${interval} minimum training width (${effectiveMinTrainingBars}); clamped to ${resolvedRollingTrainBars}`
    );
  }

  // Calculate walk-forward windows
  const windows = calculateWindows(candles.length, effectiveMinTrainingBars, testWindowBars, stepSizeBars, {
    purgeGapBars: resolvedPurgeGapBars,
    mode: windowMode,
    rollingTrainBars: resolvedRollingTrainBars,
  });

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

    // Stops scale with this window's own volatility, measured on training bars
    // only, so the out-of-sample test inherits them without seeing test data.
    const stops = deriveVolatilityStops(trainingCandles, WALK_FORWARD_FEE_PERCENT);

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
        stopLossPercent: stops.stopLossPercent,
        takeProfitPercent: stops.takeProfitPercent,
        feePercent: WALK_FORWARD_FEE_PERCENT,
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
      stopLossPercent: stops.stopLossPercent,
      takeProfitPercent: stops.takeProfitPercent,
      feePercent: WALK_FORWARD_FEE_PERCENT,
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
 * Calculate walk-forward windows.
 *
 * mode 'anchored' (default) keeps trainStart at 0, so each window's training
 * set expands. mode 'rolling' keeps a fixed training width (rollingTrainBars,
 * default minTrainingBars), sliding trainStart forward with trainEnd instead.
 *
 * purgeGapBars (default 0) inserts a gap of untraded bars between trainEnd
 * and testStart, so indicator warmup state and autocorrelated volatility from
 * training cannot leak into the test window.
 */
export function calculateWindows(
  totalBars: number,
  minTrainingBars: number,
  testWindowBars: number,
  stepSizeBars: number,
  opts?: { purgeGapBars?: number; mode?: 'anchored' | 'rolling'; rollingTrainBars?: number }
): Array<{ trainStart: number; trainEnd: number; testStart: number; testEnd: number }> {
  const purgeGapBars = opts?.purgeGapBars ?? 0;
  const mode = opts?.mode ?? 'anchored';
  const rollingTrainBars = opts?.rollingTrainBars ?? minTrainingBars;

  const windows: Array<{
    trainStart: number;
    trainEnd: number;
    testStart: number;
    testEnd: number;
  }> = [];

  let trainEnd = minTrainingBars - 1;

  while (trainEnd + 1 + purgeGapBars + testWindowBars - 1 < totalBars) {
    const testStart = trainEnd + 1 + purgeGapBars;
    const testEnd = Math.min(testStart + testWindowBars - 1, totalBars - 1);
    const trainStart = mode === 'rolling' ? Math.max(0, trainEnd - rollingTrainBars + 1) : 0;

    windows.push({
      trainStart,
      trainEnd,
      testStart,
      testEnd,
    });

    // Expand (anchored) or slide (rolling) the training window by step size
    trainEnd += stepSizeBars;
  }

  return windows;
}

/**
 * Choose a step size that keeps the window count near a target regardless of
 * series length.
 *
 * A fixed step interacts badly with per-style intervals: at 300 bars, three
 * months of 5m candles produced ~85 windows and a 48-month daily series only
 * one. Since windows are anchored-expanding, each extra window costs a full
 * backtest over all training bars so far, and candidatesPerWindow multiplies
 * that. Deriving the step from the data keeps total work predictable at both
 * extremes.
 *
 * Returns at least 1. Series too short for more than one window fall back to
 * the remaining span, which calculateWindows resolves to a single window.
 */
export function deriveStepSize(
  totalBars: number,
  minTrainingBars: number,
  testWindowBars: number,
  targetWindows: number
): number {
  if (targetWindows < 1) {
    throw new Error(`targetWindows must be at least 1, received ${targetWindows}`);
  }

  const steppableBars = totalBars - minTrainingBars - testWindowBars;

  if (steppableBars <= 0) {
    return Math.max(1, testWindowBars);
  }

  return Math.max(1, Math.floor(steppableBars / targetWindows));
}

/** Stops sized to a window's volatility, as fractions of entry price. */
export interface VolatilityStops {
  stopLossPercent: number;
  takeProfitPercent: number;
  medianTrueRangePercent: number;
}

export const STOP_TRUE_RANGE_MULTIPLE = 2;
export const TARGET_TRUE_RANGE_MULTIPLE = 4;
/** Binance spot taker fee per side, applied to every walk-forward backtest. */
export const WALK_FORWARD_FEE_PERCENT = 0.001;
/**
 * A stop must be at least this many round-trip fees wide, which caps fee drag
 * at 20% of the risk taken. Without it, 5m BTC got a 0.25% stop against 0.2%
 * round-trip fees: fees consumed 80% of every trade's risk and a 90-day
 * backtest lost the whole account (9,419 in fees on 10,000 of equity).
 */
export const MIN_STOP_ROUND_TRIP_FEES = 5;
const MIN_STOP_FRACTION = 0.0025;
const MAX_STOP_FRACTION = 0.25;

/**
 * Stop-loss and take-profit from the median true range of the given bars.
 *
 * A flat 3% stop and 6% target were applied to every style. On 5m candles a 3%
 * move is rare, and on daily SOL it is an ordinary day, so position-trading
 * candidates were stopped out constantly (338 trades in 1,440 daily bars) while
 * intraday stops never came into play. Two median true ranges for the stop and
 * four for the target keep the previous 1:2 risk-reward at each interval's own
 * scale. The median resists the occasional crash bar that would inflate a mean.
 *
 * The stop is floored at five round-trip fees (and never below 0.25%), capped at
 * 25%, and the target keeps the same multiple of it.
 */
export function deriveVolatilityStops(candles: OHLCV[], feePercent = 0): VolatilityStops {
  const minStop = Math.max(MIN_STOP_FRACTION, 2 * feePercent * MIN_STOP_ROUND_TRIP_FEES);
  const ranges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    if (!(prevClose > 0)) continue;
    const trueRange = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    ranges.push(trueRange / prevClose);
  }

  if (ranges.length === 0) {
    const stopLossPercent = minStop;
    return {
      stopLossPercent,
      takeProfitPercent: stopLossPercent * (TARGET_TRUE_RANGE_MULTIPLE / STOP_TRUE_RANGE_MULTIPLE),
      medianTrueRangePercent: 0,
    };
  }

  ranges.sort((a, b) => a - b);
  const mid = Math.floor(ranges.length / 2);
  const median = ranges.length % 2 === 0 ? (ranges[mid - 1] + ranges[mid]) / 2 : ranges[mid];

  const stopLossPercent = Math.min(
    MAX_STOP_FRACTION,
    Math.max(minStop, median * STOP_TRUE_RANGE_MULTIPLE)
  );

  return {
    stopLossPercent,
    takeProfitPercent: stopLossPercent * (TARGET_TRUE_RANGE_MULTIPLE / STOP_TRUE_RANGE_MULTIPLE),
    medianTrueRangePercent: median,
  };
}
