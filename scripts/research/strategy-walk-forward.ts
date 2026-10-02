/**
 * Pure, Mongo-free walk-forward over a strategy family's parameter grid.
 *
 * Inputs: a candle series, a StrategyFamily (scripts/research/strategy-
 * families.ts) and the grid cells to test (typically expandGrid(family)),
 * costs, funding, and window sizing. Output: one WindowResult per window,
 * each carrying every cell's in-sample summary, every cell's out-of-sample
 * summary, and (for the cell selected in-sample) the full out-of-sample
 * trade list, a cost-stress rerun, and a random-entry-benchmark p-value.
 * Nothing here reaches Mongo or the filesystem; every input is a plain
 * value the caller supplies.
 *
 * Window math (resolveWindowConfig): trainBars is trainFraction of the
 * series, floored at the style's own indicator warmup plus a 10-bar margin
 * (computeMinCandles(indicatorConfig) + 10), matching runWalkForward's own
 * floor in src/lib/optimization/walk-forward.ts. The purge gap between
 * training and test data is the style's indicator warmup measured on that
 * training prefix (computeWarmupBars over computeAllIndicators), the same
 * derivation runWalkForward uses, so indicator state and autocorrelated
 * volatility from training cannot leak into a test window. testWindowBars
 * is the remaining span divided evenly across `windows.count`, and
 * stepSizeBars equals testWindowBars, so calculateWindows produces exactly
 * `count` contiguous, non-overlapping out-of-sample segments.
 *
 * Selection rule: within a window, every grid cell runs once in-sample: the
 * cell with the highest in-sample expectancyPercent among cells that traded
 * at least `minIsTrades` times is selected (ties go to the earliest grid
 * index, i.e. Array.prototype.find/reduce's natural left-to-right scan). A
 * window where no cell reaches the floor records a null selection and a
 * reason, but every cell's out-of-sample summary is still computed, so the
 * per-cell table stays complete across every window regardless of whether
 * anything was selected.
 *
 * Stops: stopLossPercent/takeProfitPercent are derived once per window from
 * the training bars' own volatility (deriveVolatilityStops), floored at a
 * multiple of the taker fee so fees cannot consume the whole risk budget,
 * and reused unchanged for that window's in-sample, out-of-sample, and
 * stress runs.
 *
 * Benchmark seed derivation: each window's random-entry benchmark uses
 * `benchmark.seed + 100000 * (index + 1)` (index is 0-based), so no two
 * windows in a single run share a seed and reruns of the same input are
 * fully deterministic.
 *
 * Purge invariant: the bar loop only starts trading testSlice at
 * preparedTest.warmupBars, so testSliceStart + preparedTest.warmupBars must
 * equal testStart or the run would silently score the wrong bar as the
 * window's first out-of-sample trade; this is asserted, not just assumed,
 * before every window's out-of-sample runs.
 */

import type { OHLCV } from '@/types/market';
import type { MarketSession } from '@/lib/sessions';
import type { TradingStyle } from '@/lib/models/signal-template';
import { DEFAULT_TEMPLATE_THRESHOLDS, DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { computeAllIndicators, computeMinCandles } from '@/lib/indicators/compute';
import { computeWarmupBars } from '@/lib/indicators/interpret-at-bar';
import { prepareBacktest, runOptimizedBacktest, type HtfInput } from '@/lib/backtest/optimized-engine';
import { calculateWindows, deriveVolatilityStops } from '@/lib/optimization/walk-forward';
import { perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import { randomEntryBenchmark } from '@/lib/backtest/random-entry-benchmark';
import { computeExpectancy } from '@/lib/backtest/metrics';
import { maxDrawdownPercentOfPnl } from '@/lib/stats/block-bootstrap';
import { intervalToMs } from '@/lib/intervals';
import type { LeanSnapshot } from '@/lib/backtest/snapshot-series';
import type { ResearchRow } from '@/lib/backtest/research-series';
import type { BacktestConfig, BacktestResult, BacktestTrade, ExitReason, TradeSide } from '@/lib/backtest/types';
import type { StrategyFamily } from './strategy-families';

export interface StrategyCosts {
  feePercent: number;
  makerFeePercent: number;
  takerFeePercent: number;
  slippageBps: number;
}

export interface StrategyWalkForwardInput {
  candles: OHLCV[];
  symbol: string;
  interval: string;
  style: TradingStyle;
  family: StrategyFamily;
  cells: Record<string, number>[];
  snapshots?: LeanSnapshot[];
  /** 1h snapshot rows for the scorer's L/S z when `snapshots` are 4h/1d (configVersion 8). */
  lsRows1h?: LeanSnapshot[];
  /**
   * Research-only per-bar columns for this symbol, precomputed over the FULL
   * candle series by the caller and keyed by candle open time.
   *
   * Both prepareBacktest calls below receive the same rows, so a column means
   * the same thing in-sample and out-of-sample. That is the point: a family
   * deriving its own trailing window from ctx.snapshots would get the full
   * window on the train slice and a truncated one on the test slice, and cell
   * selection would then optimise a different factor from the one scored.
   */
  researchRows?: readonly ResearchRow[];
  htfInput?: HtfInput;
  costs: StrategyCosts;
  fundingEnabled: boolean;
  windows: { count: number; trainFraction: number; mode: 'rolling' | 'anchored' };
  minIsTrades: number;
  stress: { feeMultiplier: number; slippageMultiplier: number };
  benchmark: { iterations: number; seed: number } | null;
  /**
   * Entry session gate, applied to `baseConfig` below so every in-sample
   * cell, every out-of-sample cell, the stress rerun (which spreads
   * `baseConfig`), and the random-entry benchmark (which receives
   * `baseConfig` directly) all see the same gate -- the benchmark must, or
   * its p-value would compare a gated strategy against an ungated null.
   * Undefined/empty means every session is allowed (BacktestConfig's own
   * default).
   */
  allowedSessions?: MarketSession[];
  onWindow?: (info: { index: number; total: number; ms: number }) => void;
}

export interface CellSummary {
  params: Record<string, number>;
  trades: number;
  expectancyPercent: number;
  expectancyR: number | null;
  perTradeSharpe: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPercent: number;
}

export interface OosTrade {
  entryTime: number;
  exitTime: number;
  side: TradeSide;
  pnl: number;
  pnlPercent: number;
  riskPercent: number;
  holdTimeBars: number;
  exitReason: ExitReason;
  fees: number;
  slippageCost: number;
  fundingCost: number;
}

export interface OosSummary {
  trades: number;
  expectancyPercent: number;
  expectancyR: number | null;
  winRate: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  medianHoldBars: number;
  fees: number;
  slippageCost: number;
  fundingCost: number;
  /** Share of scored bars with a usable futures snapshot (result.snapshotCoverage's
   * futuresPercent), null when no snapshot series was supplied at all. */
  snapshotCoveragePercent: number | null;
}

export interface WindowResult {
  index: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  selectedParams: Record<string, number> | null;
  skippedReason: string | null;
  isCells: CellSummary[];
  oosCells: Array<{ params: Record<string, number>; trades: number; expectancyPercent: number; pnlPercents: number[] }>;
  oos: OosSummary | null;
  oosTrades: OosTrade[];
  stress: { trades: number; expectancyPercent: number; pnlPercents: number[] } | null;
  benchmark: {
    iterations: number;
    seed: number;
    meanRandom: number;
    sdRandom: number;
    pValue: number;
    referenceTrades: number;
    randomExpectancies: number[];
  } | null;
}

export interface WindowConfig {
  trainBars: number;
  testWindowBars: number;
  purgeGapBars: number;
  stepSizeBars: number;
  mode: 'rolling' | 'anchored';
  count: number;
}

export interface StrategyWalkForwardResult {
  symbol: string;
  interval: string;
  style: TradingStyle;
  windowConfig: WindowConfig;
  windows: WindowResult[];
}

/**
 * Resolves the fixed window geometry (train width, purge gap, test width,
 * step) from a candle series and the walk-forward's `windows` request, and
 * the concrete per-window boundaries (`bounds`) calculateWindows produces
 * from that geometry. Exported so callers (and tests) can reproduce window
 * boundaries exactly without re-running a full walk-forward.
 *
 * Throws when the resulting test window would be under 50 bars: too short
 * a test window to trust a handful of trades' expectancy on.
 */
export function resolveWindowConfig(
  candles: OHLCV[],
  symbol: string,
  interval: string,
  style: TradingStyle,
  windows: StrategyWalkForwardInput['windows']
): WindowConfig & { bounds: Array<{ trainStart: number; trainEnd: number; testStart: number; testEnd: number }> } {
  const indicatorConfig = getStyleConfig(style).config;
  const minTrain = computeMinCandles(indicatorConfig) + 10;
  const N = candles.length;
  const trainBars = Math.max(Math.floor(N * windows.trainFraction), minTrain);

  const purgeGapBars = computeWarmupBars(
    computeAllIndicators(candles.slice(0, trainBars), symbol, interval, indicatorConfig)
  );

  const testWindowBars = Math.floor((N - trainBars - purgeGapBars) / windows.count);
  if (testWindowBars < 50) {
    throw new Error(
      `insufficient data: N=${N}, trainBars=${trainBars}, purgeGapBars=${purgeGapBars}, count=${windows.count} ` +
        `yields testWindowBars=${testWindowBars} (< 50)`
    );
  }

  const stepSizeBars = testWindowBars;
  const bounds = calculateWindows(N, trainBars, testWindowBars, stepSizeBars, {
    purgeGapBars,
    mode: windows.mode,
    rollingTrainBars: trainBars,
  });

  return {
    trainBars,
    testWindowBars,
    purgeGapBars,
    stepSizeBars,
    mode: windows.mode,
    count: windows.count,
    bounds,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function toOosTrade(trade: BacktestTrade): OosTrade {
  return {
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    side: trade.side,
    pnl: trade.pnl,
    pnlPercent: trade.pnlPercent,
    riskPercent: trade.riskPercent,
    holdTimeBars: trade.holdTimeBars,
    exitReason: trade.exitReason,
    fees: trade.fees,
    slippageCost: trade.slippageCost,
    fundingCost: trade.fundingCost,
  };
}

function buildOosSummary(result: BacktestResult): OosSummary {
  const { trades } = result;
  return {
    trades: trades.length,
    expectancyPercent: result.metrics.expectancyPercent,
    expectancyR: result.metrics.expectancyR,
    winRate: result.metrics.winRate,
    profitFactor: result.metrics.profitFactor,
    maxDrawdownPercent: result.metrics.maxDrawdownPercent,
    medianHoldBars: median(trades.map((t) => t.holdTimeBars)),
    fees: trades.reduce((sum, t) => sum + t.fees, 0),
    slippageCost: trades.reduce((sum, t) => sum + t.slippageCost, 0),
    fundingCost: trades.reduce((sum, t) => sum + t.fundingCost, 0),
    snapshotCoveragePercent: result.snapshotCoverage?.futuresPercent ?? null,
  };
}

function buildCellSummary(params: Record<string, number>, result: BacktestResult): CellSummary {
  return {
    params,
    trades: result.trades.length,
    expectancyPercent: result.metrics.expectancyPercent,
    expectancyR: result.metrics.expectancyR,
    perTradeSharpe: perPeriodSharpe(result.trades.map((t) => t.pnlPercent)),
    winRate: result.metrics.winRate,
    profitFactor: result.metrics.profitFactor,
    maxDrawdownPercent: result.metrics.maxDrawdownPercent,
  };
}

/** The cell with the highest in-sample expectancyPercent among cells at or
 * above minIsTrades trades; earliest index wins ties. -1 when none qualify. */
function selectCellIndex(isCells: CellSummary[], minIsTrades: number): number {
  let best = -1;
  for (let i = 0; i < isCells.length; i++) {
    if (isCells[i].trades < minIsTrades) continue;
    if (best === -1 || isCells[i].expectancyPercent > isCells[best].expectancyPercent) {
      best = i;
    }
  }
  return best;
}

export function runStrategyWalkForward(input: StrategyWalkForwardInput): StrategyWalkForwardResult {
  const {
    candles,
    symbol,
    interval,
    style,
    family,
    cells,
    snapshots,
    lsRows1h,
    researchRows,
    htfInput,
    costs,
    fundingEnabled,
    windows,
    minIsTrades,
    stress,
    benchmark,
    allowedSessions,
    onWindow,
  } = input;

  const indicatorConfig = getStyleConfig(style).config;
  const resolved = resolveWindowConfig(candles, symbol, interval, style, windows);
  const thresholds = DEFAULT_TEMPLATE_THRESHOLDS[style];
  const weights = DEFAULT_TEMPLATE_WEIGHTS[style];
  const strategyCtx = { style, interval };

  const windowResults: WindowResult[] = [];

  for (let index = 0; index < resolved.bounds.length; index++) {
    const startedAt = Date.now();
    const { trainStart, trainEnd, testStart, testEnd } = resolved.bounds[index];

    // 1. Train slice, prepared indicators, and this window's own stops.
    const train = candles.slice(trainStart, trainEnd + 1);
    const preparedTrain = prepareBacktest(train, symbol, interval, indicatorConfig, snapshots, htfInput, researchRows, lsRows1h);
    const stops = deriveVolatilityStops(train, costs.takerFeePercent);

    // 2. Base config, reused for every cell in this window.
    const baseConfig: BacktestConfig = {
      entryThreshold: thresholds.entryThreshold,
      exitThreshold: thresholds.exitThreshold,
      shortEntryThreshold: thresholds.shortEntryThreshold,
      shortExitThreshold: thresholds.shortExitThreshold,
      weights,
      allowShorts: true,
      positionSizing: { method: 'risk_based', riskPerTrade: 0.01 },
      positionSizePercent: 0.1,
      stopLossPercent: stops.stopLossPercent,
      takeProfitPercent: stops.takeProfitPercent,
      feePercent: costs.feePercent,
      makerFeePercent: costs.makerFeePercent,
      takerFeePercent: costs.takerFeePercent,
      slippageBps: costs.slippageBps,
      fundingEnabled,
      startEquity: 10000,
      ...(allowedSessions && allowedSessions.length > 0 ? { allowedSessions } : {}),
    };

    // 3. Every cell, in-sample.
    const isCells: CellSummary[] = cells.map((cell) => {
      const strategy = family.create(cell, strategyCtx);
      const result = runOptimizedBacktest(preparedTrain, baseConfig, symbol, interval, undefined, strategy);
      return buildCellSummary(cell, result);
    });

    // 4. Selection: highest in-sample expectancy among cells at or above
    // minIsTrades trades, earliest index wins ties.
    const selectedIndex = selectCellIndex(isCells, minIsTrades);
    const selectedParams = selectedIndex === -1 ? null : cells[selectedIndex];
    const skippedReason =
      selectedIndex === -1 ? `no cell reached ${minIsTrades} in-sample trades` : null;

    // 5. Out-of-sample: every cell, so the per-cell table is complete
    // whether or not anything was selected.
    const testSliceStart = Math.max(0, testStart - preparedTrain.warmupBars);
    const testSlice = candles.slice(testSliceStart, testEnd + 1);
    const preparedTest = prepareBacktest(testSlice, symbol, interval, indicatorConfig, snapshots, htfInput, researchRows, lsRows1h);

    // The bar loop skips preparedTest.warmupBars bars of testSlice before it
    // starts trading, so the first traded bar of testSlice must land exactly
    // on testStart -- today that holds only because prepareBacktest's
    // warmupBars is a pure function of (indicatorConfig, candle count), so
    // preparedTrain.warmupBars and preparedTest.warmupBars happen to agree.
    // Guarded explicitly rather than trusted, since a future indicator
    // change that makes warmupBars depend on candle content (not just count)
    // would silently start trading on the wrong bar otherwise.
    if (testSliceStart + preparedTest.warmupBars !== testStart) {
      throw new Error(
        `purge invariant violated: testSliceStart=${testSliceStart} + preparedTest.warmupBars=${preparedTest.warmupBars} !== testStart=${testStart}`
      );
    }

    const oosRuns: BacktestResult[] = cells.map((cell) => {
      const strategy = family.create(cell, strategyCtx);
      return runOptimizedBacktest(preparedTest, baseConfig, symbol, interval, undefined, strategy);
    });

    const oosCells = oosRuns.map((result, i) => ({
      params: cells[i],
      trades: result.trades.length,
      expectancyPercent: result.metrics.expectancyPercent,
      pnlPercents: result.trades.map((t) => t.pnlPercent),
    }));

    let oos: OosSummary | null = null;
    let oosTrades: OosTrade[] = [];
    let stressResult: WindowResult['stress'] = null;
    let benchmarkResult: WindowResult['benchmark'] = null;

    if (selectedIndex !== -1) {
      const selectedOosResult = oosRuns[selectedIndex];
      oos = buildOosSummary(selectedOosResult);
      oosTrades = selectedOosResult.trades.map(toOosTrade);

      // 6. Stress rerun, selected cell only: costs scaled up, stops unchanged.
      const stressConfig: BacktestConfig = {
        ...baseConfig,
        feePercent: baseConfig.feePercent * stress.feeMultiplier,
        makerFeePercent: (baseConfig.makerFeePercent as number) * stress.feeMultiplier,
        takerFeePercent: (baseConfig.takerFeePercent as number) * stress.feeMultiplier,
        slippageBps: (baseConfig.slippageBps as number) * stress.slippageMultiplier,
      };
      const stressStrategy = family.create(cells[selectedIndex], strategyCtx);
      const stressRun = runOptimizedBacktest(
        preparedTest,
        stressConfig,
        symbol,
        interval,
        undefined,
        stressStrategy
      );
      stressResult = {
        trades: stressRun.trades.length,
        expectancyPercent: stressRun.metrics.expectancyPercent,
        pnlPercents: stressRun.trades.map((t) => t.pnlPercent),
      };

      // 7. Random-entry benchmark, only when requested and the selected
      // cell actually traded out of sample.
      if (benchmark !== null && selectedOosResult.trades.length > 0) {
        const seed = benchmark.seed + 100000 * (index + 1);
        // The selected cell's own entry mechanism, so a limit family's null
        // rests the same limit and pays the same maker fee (review M4).
        const bm = randomEntryBenchmark(preparedTest, baseConfig, symbol, interval, selectedOosResult, {
          iterations: benchmark.iterations,
          seed,
          entryWrapper: stressStrategy.entryWrapper,
        });
        benchmarkResult = {
          iterations: benchmark.iterations,
          seed,
          meanRandom: bm.meanRandom,
          sdRandom: bm.sdRandom,
          pValue: bm.pValue,
          referenceTrades: selectedOosResult.trades.length,
          randomExpectancies: bm.randomExpectancies,
        };
      }
    }

    windowResults.push({
      index,
      trainStart,
      trainEnd,
      testStart,
      testEnd,
      selectedParams,
      skippedReason,
      isCells,
      oosCells,
      oos,
      oosTrades,
      stress: stressResult,
      benchmark: benchmarkResult,
    });

    if (onWindow) {
      onWindow({ index, total: resolved.bounds.length, ms: Date.now() - startedAt });
    }
  }

  return {
    symbol,
    interval,
    style,
    windowConfig: {
      trainBars: resolved.trainBars,
      testWindowBars: resolved.testWindowBars,
      purgeGapBars: resolved.purgeGapBars,
      stepSizeBars: resolved.stepSizeBars,
      mode: resolved.mode,
      count: resolved.count,
    },
    windows: windowResults,
  };
}

/**
 * FIXED-EVALUATION MODE (legends phase, 2026-10-02; plan B3). For a rule whose
 * every parameter is fixed in advance there is nothing to select, so there is
 * no training span: the run is ONE continuous backtest per symbol from
 * `evalFrom` (after the style's indicator warmup) to the end of the data. The
 * windows exist only for the windows gate: the evaluated span is cut into
 * `windowCount` equal calendar spans and each trade is assigned to the span
 * its EXIT falls in. One continuous run, unlike `runStrategyWalkForward`'s
 * separate test windows, never forces a long trade closed at a window edge.
 *
 * The result has the walk-forward's shape, so `poolStrategyResults` and the
 * eight gates read it unchanged: `isCells` is empty, each window's `oosCells`
 * is the single cell's trades in that span, the stress run is split the same
 * way, and the one random-entry benchmark (over the whole run, entering with
 * the family's own `entryWrapper`) is attached to the first window with the
 * run's full trade count as its weight.
 *
 * The candles are SLICED so the loop's warmup ends exactly at the first bar
 * at or after `evalFrom` (asserted, like the walk-forward's purge invariant),
 * so neither the rule nor its null can trade earlier, and the null's
 * per-bar entry rate is calibrated on the evaluated bars only.
 */
export interface FixedEvaluationInput {
  candles: OHLCV[];
  symbol: string;
  interval: string;
  style: TradingStyle;
  family: StrategyFamily;
  cell: Record<string, number>;
  snapshots?: LeanSnapshot[];
  lsRows1h?: LeanSnapshot[];
  researchRows?: readonly ResearchRow[];
  htfInput?: HtfInput;
  costs: StrategyCosts;
  fundingEnabled: boolean;
  /** Settled funding rates; when given, funding accrues from them per bar (BarLoopInput.fundingSums). */
  settlements?: ReadonlyArray<{ t: number; rate: number }>;
  /** First bar OPEN time the run may trade; earlier bars are warmup only. */
  evalFrom: number;
  windowCount: number;
  stress: { feeMultiplier: number; slippageMultiplier: number };
  benchmark: { iterations: number; seed: number } | null;
}

export interface FixedEvaluationExtras {
  /** Index of the first evaluated bar in the input candles. */
  evalStartIndex: number;
  evalStartTime: number;
  warmupBars: number;
  /** Stop-entry bookkeeping from the main run (zeros when it placed none). */
  stopEntries: { placed: number; filled: number; ambiguous: number; expired: number };
  /** Stop exits on bars that also reached the target: the bars whose order OHLC cannot tell. */
  stopExitsReachingTarget: number;
  /** The same run with a bar reaching both booked as the target (the optimistic bound). */
  targetFirst: { trades: number; expectancyPercent: number };
}

/** Per bar of `candles`, the settled rates in (open, open + interval], i.e. (previous close, this close]. */
export function fundingSumsFor(
  candles: OHLCV[],
  intervalMs: number,
  settlements: ReadonlyArray<{ t: number; rate: number }>
): Float64Array {
  const sums = new Float64Array(candles.length);
  const sorted = [...settlements].sort((a, b) => a.t - b.t);
  let p = 0;
  for (let i = 0; i < candles.length; i++) {
    const open = candles[i].timestamp;
    while (p < sorted.length && sorted[p].t <= open) p++;
    let k = p;
    let sum = 0;
    while (k < sorted.length && sorted[k].t <= open + intervalMs) {
      sum += sorted[k].rate;
      k++;
    }
    sums[i] = sum;
  }
  return sums;
}

function windowSummary(trades: BacktestTrade[], coverage: number | null): OosSummary {
  const n = trades.length;
  const pnl = trades.map((t) => t.pnl);
  const gross = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const loss = -trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  const { expectancyPercent, expectancyR } = computeExpectancy(trades);
  return {
    trades: n,
    expectancyPercent: n > 0 ? expectancyPercent : Number.NaN,
    expectancyR,
    winRate: n > 0 ? trades.filter((t) => t.pnl > 0).length / n : Number.NaN,
    profitFactor: loss > 0 ? gross / loss : gross > 0 ? Infinity : Number.NaN,
    maxDrawdownPercent: n > 0 ? maxDrawdownPercentOfPnl(pnl, 10000) : Number.NaN,
    medianHoldBars: median(trades.map((t) => t.holdTimeBars)),
    fees: trades.reduce((s, t) => s + t.fees, 0),
    slippageCost: trades.reduce((s, t) => s + t.slippageCost, 0),
    fundingCost: trades.reduce((s, t) => s + t.fundingCost, 0),
    snapshotCoveragePercent: coverage,
  };
}

export function runFixedEvaluation(
  input: FixedEvaluationInput
): StrategyWalkForwardResult & { fixed: FixedEvaluationExtras } {
  const { candles, symbol, interval, style, family, cell, costs, fundingEnabled, stress, benchmark } = input;
  const indicatorConfig = getStyleConfig(style).config;
  const thresholds = DEFAULT_TEMPLATE_THRESHOLDS[style];
  const weights = DEFAULT_TEMPLATE_WEIGHTS[style];

  const evalIdx = candles.findIndex((c) => c.timestamp >= input.evalFrom);
  if (evalIdx === -1) throw new Error(`${symbol}: no candle at or after evalFrom ${new Date(input.evalFrom).toISOString()}`);
  const warmup = computeWarmupBars(computeAllIndicators(candles, symbol, interval, indicatorConfig));
  const start = Math.max(evalIdx, warmup);
  const sliceStart = start - warmup;
  const slice = candles.slice(sliceStart);
  const prepared = prepareBacktest(
    slice,
    symbol,
    interval,
    indicatorConfig,
    input.snapshots,
    input.htfInput,
    input.researchRows,
    input.lsRows1h
  );
  if (sliceStart + prepared.warmupBars !== start) {
    throw new Error(
      `fixed-evaluation invariant violated: sliceStart=${sliceStart} + warmupBars=${prepared.warmupBars} !== start=${start}`
    );
  }
  if (input.settlements) prepared.fundingSums = fundingSumsFor(slice, intervalToMs(interval), input.settlements);

  const stops = deriveVolatilityStops(slice.slice(0, prepared.warmupBars + 1), costs.takerFeePercent);
  const baseConfig: BacktestConfig = {
    entryThreshold: thresholds.entryThreshold,
    exitThreshold: thresholds.exitThreshold,
    shortEntryThreshold: thresholds.shortEntryThreshold,
    shortExitThreshold: thresholds.shortExitThreshold,
    weights,
    allowShorts: true,
    positionSizing: { method: 'risk_based', riskPerTrade: 0.01 },
    positionSizePercent: 0.1,
    stopLossPercent: stops.stopLossPercent,
    takeProfitPercent: stops.takeProfitPercent,
    feePercent: costs.feePercent,
    makerFeePercent: costs.makerFeePercent,
    takerFeePercent: costs.takerFeePercent,
    slippageBps: costs.slippageBps,
    fundingEnabled,
    startEquity: 10000,
  };
  const stressConfig: BacktestConfig = {
    ...baseConfig,
    feePercent: baseConfig.feePercent * stress.feeMultiplier,
    makerFeePercent: (baseConfig.makerFeePercent as number) * stress.feeMultiplier,
    takerFeePercent: (baseConfig.takerFeePercent as number) * stress.feeMultiplier,
    slippageBps: (baseConfig.slippageBps as number) * stress.slippageMultiplier,
  };

  const strategyCtx = { style, interval };
  const main = runOptimizedBacktest(prepared, baseConfig, symbol, interval, undefined, family.create(cell, strategyCtx));
  const stressRun = runOptimizedBacktest(prepared, stressConfig, symbol, interval, undefined, family.create(cell, strategyCtx));
  const targetFirstRun = runOptimizedBacktest(
    prepared,
    { ...baseConfig, intrabarOrder: 'target-first' },
    symbol,
    interval,
    undefined,
    family.create(cell, strategyCtx)
  );

  let bench: WindowResult['benchmark'] = null;
  if (benchmark !== null && main.trades.length > 0) {
    const bm = randomEntryBenchmark(prepared, baseConfig, symbol, interval, main, {
      iterations: benchmark.iterations,
      seed: benchmark.seed,
      entryWrapper: family.create(cell, strategyCtx).entryWrapper,
    });
    bench = {
      iterations: benchmark.iterations,
      seed: benchmark.seed,
      meanRandom: bm.meanRandom,
      sdRandom: bm.sdRandom,
      pValue: bm.pValue,
      referenceTrades: main.trades.length,
      randomExpectancies: bm.randomExpectancies,
    };
  }

  // Calendar windows over the evaluated span, by exit time.
  const spanStart = slice[prepared.warmupBars].timestamp;
  const spanEnd = slice[slice.length - 1].timestamp + intervalToMs(interval);
  const count = Math.max(1, input.windowCount);
  const edges = Array.from({ length: count + 1 }, (_, k) => spanStart + ((spanEnd - spanStart) * k) / count);
  const windowOf = (t: number) => Math.min(count - 1, Math.max(0, Math.floor(((t - spanStart) / (spanEnd - spanStart)) * count)));
  const byWindow = <T extends { exitTime: number }>(trades: T[]) => {
    const out: T[][] = Array.from({ length: count }, () => []);
    for (const t of trades) out[windowOf(t.exitTime)].push(t);
    return out;
  };
  const mainBy = byWindow(main.trades);
  const stressBy = byWindow(stressRun.trades);
  const barOf = (t: number) => {
    const i = candles.findIndex((c) => c.timestamp >= t);
    return i === -1 ? candles.length - 1 : i;
  };
  const coverage = main.snapshotCoverage?.futuresPercent ?? null;
  const evaluatedBars = slice.length - prepared.warmupBars;

  const windows: WindowResult[] = mainBy.map((trades, index) => ({
    index,
    trainStart: sliceStart,
    trainEnd: start - 1,
    testStart: barOf(edges[index]),
    testEnd: index === count - 1 ? candles.length - 1 : barOf(edges[index + 1]) - 1,
    selectedParams: cell,
    skippedReason: null,
    isCells: [],
    oosCells: [
      {
        params: cell,
        trades: trades.length,
        expectancyPercent: trades.length > 0 ? computeExpectancy(trades).expectancyPercent : Number.NaN,
        pnlPercents: trades.map((t) => t.pnlPercent),
      },
    ],
    oos: windowSummary(trades, coverage),
    oosTrades: trades.map(toOosTrade),
    stress: {
      trades: stressBy[index].length,
      expectancyPercent: stressBy[index].length > 0 ? computeExpectancy(stressBy[index]).expectancyPercent : Number.NaN,
      pnlPercents: stressBy[index].map((t) => t.pnlPercent),
    },
    benchmark: index === 0 ? bench : null,
  }));

  let stopExitsReachingTarget = 0;
  for (const t of main.trades) {
    if (t.exitReason !== 'stop_loss' || t.rewardPercent === null) continue;
    const target = t.side === 'long' ? t.entryPrice * (1 + t.rewardPercent / 100) : t.entryPrice * (1 - t.rewardPercent / 100);
    const bar = slice[t.exitBar];
    if (t.side === 'long' ? bar.high >= target : bar.low <= target) stopExitsReachingTarget++;
  }

  return {
    symbol,
    interval,
    style,
    windowConfig: {
      trainBars: prepared.warmupBars,
      testWindowBars: Math.floor(evaluatedBars / count),
      purgeGapBars: 0,
      stepSizeBars: Math.floor(evaluatedBars / count),
      mode: 'anchored',
      count,
    },
    windows,
    fixed: {
      evalStartIndex: start,
      evalStartTime: spanStart,
      warmupBars: prepared.warmupBars,
      stopEntries: main.stopEntries ?? { placed: 0, filled: 0, ambiguous: 0, expired: 0 },
      stopExitsReachingTarget,
      targetFirst: {
        trades: targetFirstRun.trades.length,
        expectancyPercent: computeExpectancy(targetFirstRun.trades).expectancyPercent,
      },
    },
  };
}
