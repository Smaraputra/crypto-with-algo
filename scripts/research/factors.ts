/**
 * Causal, per-bar factor matrix built from the same code paths the live
 * scorer and backtests use: prepareBacktest's precomputed indicator suites
 * and SuperTrend, computeSignalScore for the composite and per-category
 * scores, and the HTF context already exported per bar by C1's
 * export-dataset.ts. No I/O: candles, snapshots, and HTF rows are supplied
 * by the caller (typically load-dataset.ts) and nothing here reaches Mongo.
 *
 * Every factor is NaN before the shared indicator warmup and whenever its
 * own input is missing at that bar (no snapshot, no HTF context, too few
 * bars of price history) -- never silently defaulted to zero, so a research
 * agent's IC measurement never mistakes "no data" for "neutral reading".
 *
 * Known divergence from live scoring: computeIndicatorsForStyle (the live
 * path, src/lib/indicators/compute-for-style.ts) nulls the raw Ichimoku
 * indicator for scalping before interpretation, so no Ichimoku signal ever
 * reaches the scorer at that style. prepareBacktest/interpretIndicatorsAtBar
 * (src/lib/backtest/optimized-engine.ts, shared with ordinary backtesting)
 * has no such style awareness -- every style gets Ichimoku interpreted, a
 * pre-existing divergence this file cannot fix at the source without
 * touching src/, and which any backtest/harness branch built on
 * optimized-engine.ts inherits too. computeFactorMatrix works around it
 * locally, for factor computation only, by stripping the Ichimoku reading
 * and signal from the suite it hands to computeSignalScore when style is
 * scalping (see excludeIchimokuForScalping below).
 */

import type { TradingStyle } from '@/lib/models/signal-template';
import { DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { SignalComponent, SignalWeights } from '@/types/signal';
import type { OHLCV } from '@/types/market';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { prepareBacktest } from '@/lib/backtest/optimized-engine';
import { computeSignalScore } from '@/lib/signals/scorer';
import type { LeanSnapshot } from '@/lib/backtest/snapshot-series';
import type { CandleRow, HtfRow, MetricsRow, PerpCandleRow, SnapshotRow } from './dataset-format';
import { alignToBars, METRICS_SLOT_MS } from '@/lib/archive-ingestion';
import { intervalToMs } from '@/lib/intervals';

export interface FactorMatrix {
  names: string[];
  categories: string[];
  values: Array<Float64Array>;
  warmupBars: number;
  timestamps: number[];
  closes: number[];
}

export interface FactorMatrixInput {
  candles: CandleRow[];
  snapshots: SnapshotRow[] | null;
  htf: HtfRow[];
  interval: string;
  /**
   * The archive's 5m futures-metrics grid for this symbol, from
   * scripts/research/load-dataset.ts's loadMetrics. Optional: omit it and
   * every metrics-derived factor is NaN for the whole series, which is what
   * every study before this input existed measured.
   */
  metrics?: MetricsRow[] | null;
  /** Perpetual bars for this symbol and interval, the traded series. */
  perp?: PerpCandleRow[] | null;
  /** The premium index series for the same symbol and interval. */
  premiumIndex?: PerpCandleRow[] | null;
}

// Fixes each interval's indicator periods and DEFAULT_TEMPLATE_WEIGHTS, per the brief.
const STYLE_FOR_INTERVAL: Record<string, TradingStyle> = {
  '5m': 'scalping',
  '15m': 'day_trading',
  '1h': 'day_trading',
  '4h': 'swing_trading',
  '1d': 'position_trading',
};

/** Exported so export-dataset.ts resolves the same style for the same interval when it needs the style's indicator config (e.g. for the HTF context). */
export function styleForInterval(interval: string): TradingStyle {
  const style = STYLE_FOR_INTERVAL[interval];
  if (!style) {
    throw new Error(`No trading style mapped for interval "${interval}"`);
  }
  return style;
}

/** See this file's header: strips Ichimoku's raw reading and derived trend signal, matching computeIndicatorsForStyle's scalping behavior that prepareBacktest itself does not have. */
function excludeIchimokuForScalping(suite: IndicatorSuite): IndicatorSuite {
  if (!suite.ichimoku && !suite.signals.trend.some((s) => s.name === 'Ichimoku')) {
    return suite;
  }
  return {
    ...suite,
    ichimoku: null,
    signals: {
      ...suite.signals,
      trend: suite.signals.trend.filter((s) => s.name !== 'Ichimoku'),
    },
  };
}

export function toOHLCV(row: CandleRow): OHLCV {
  return {
    timestamp: row.t,
    open: row.o,
    high: row.h,
    low: row.l,
    close: row.c,
    volume: row.v,
    ...(row.tbv !== null ? { takerBuyVolume: row.tbv } : {}),
  };
}

/** Inverse of the export side's row shaping in scripts/research/export-dataset.ts. */
export function toLeanSnapshot(row: SnapshotRow): LeanSnapshot {
  return {
    timestamp: row.t,
    data: {
      fundingRate: row.fundingRate
        ? { rate: row.fundingRate.rate, markPrice: row.fundingRate.markPrice ?? undefined }
        : undefined,
      longShortRatio: row.longShortRatio ?? undefined,
      openInterest: row.openInterest ?? undefined,
      newsSentiment: row.newsSentiment ?? undefined,
      fearGreed: row.fearGreed ?? undefined,
    },
  };
}

const CATEGORY_ORDER: (keyof SignalWeights)[] = [
  'trend',
  'momentum',
  'volume',
  'volatility',
  'futures',
  'sentiment',
  'htf',
];

/**
 * PRE-REGISTRATION, 2026-09-25, for the three book-depth columns added below.
 * Written before any measurement; the results go in factor-ic.ts's header.
 *
 * All three come from `depthNotional1` and `depthNotional5`, which
 * `export-dataset.ts` has always written into `MetricsRow` and which no factor
 * has ever read. They need no ingestion and no re-export.
 *
 * MEASURED AT 5m AND 15m FIRST, not at 4h. Recovering per-trade dispersion from
 * the recorded bootstrap CIs puts the statistical bar at about 0.010% at 5m
 * against 0.450% at 4h, so a 4h reading cannot be proven at the sample on hand
 * even if the effect is real. At lag 1, per the standing ruling.
 *
 * SURVIVOR RULE, FIXED NOW: the existing rule (|ic| >= 0.02, two or more
 * horizons, 60% quarter agreement, 70% symbol agreement) with |t| raised from
 * 2.5 to 3.15, and Benjamini-Hochberg FDR at 0.10 across the phase's cells.
 * 3.15 is the empirically calibrated value: |t| > 2.5 fires on 4.0% to 4.5% of
 * zero-edge trials for a persistent factor against a nominal 1.24%, and at 3.15
 * no existing survivor is lost.
 *
 * PREDICTED SIGNS:
 *
 * - `raw.depthFlow1`: POSITIVE, and this is the only one with a real prior.
 *   Order-flow imbalance is continuation-shaped in the literature: price
 *   follows flow. That is the OPPOSITE sign to `raw.depthImbalance1`, which
 *   this program measured as contrarian at 4h and 1d (lag 1: 4h h16 -0.0408
 *   t -5.8, 1d h8-32). Level crowded means fade; flow means follow. The sign
 *   contrast is the test, and a negative flow IC would mean the two columns are
 *   measuring the same thing and this adds nothing.
 *   It also matters for execution: Stage 0 established that a passive entry on
 *   a mean-reversion signal is adversely selected, so only a
 *   continuation-shaped signal can use the 0.04% maker cost bar at all.
 *
 * - `raw.depthNotional1`: NO SURVIVOR EXPECTED. A liquidity level is a state
 *   variable, not a direction. If it survives as a direct factor it is more
 *   likely proxying market regime or a symbol's size than predicting returns,
 *   and it should be treated as a conditioner rather than a signal.
 *
 * - `raw.depthSlope`: NO SURVIVOR EXPECTED, same reasoning. A book that thickens
 *   away from the touch implies higher impact per unit size, which is an
 *   execution cost input rather than a forecast.
 *
 * Recording two predicted non-survivors matters as much as the one predicted
 * survivor: if all three clear the rule, the likeliest explanation is that the
 * rule is too loose for this input, not that three independent edges appeared.
 */
const RAW_NAMES = [
  'raw.rsi',
  'raw.emaSpreadPct',
  'raw.atrPct',
  'raw.fundingRate',
  'raw.longShortRatio',
  'raw.takerBuyRatio',
  'raw.fearGreed',
  'raw.htfTrend',
  'raw.ret1',
  'raw.ret5',
  'raw.ret20',
  'raw.realizedVol20',
  // Archive-only inputs. Before scripts/ops/ingest-archive.ts existed, Binance
  // REST served these for about 30 days, so stored open interest and
  // positioning covered 11.0% of 1h bars and nothing before 2026-03-03.
  'raw.oiChange1',
  'raw.oiChange8',
  'raw.oiPriceDiv',
  'raw.takerLongShortRatio',
  'raw.topTraderPositionRatio',
  'raw.globalAccountRatio',
  'raw.fundingZ',
  'raw.basisPct',
  'raw.perpSpotSpreadPct',
  'raw.depthImbalance1',
  'raw.depthImbalance5',
  'raw.depthNotional1',
  'raw.depthSlope',
  'raw.depthFlow1',
] as const;

/**
 * Trailing window for the funding z-score, in days rather than bars.
 *
 * Funding settles every 8h, so a bar-count window degenerates at fine
 * intervals: 96 bars at 5m is a single funding period, over which the
 * standard deviation is zero or near it. Thirty days spans about ninety
 * settlements at every interval.
 */
export const FUNDING_Z_DAYS = 30;
/** Finite readings needed before a z-score is emitted rather than NaN. */
export const FUNDING_Z_MIN_SAMPLES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Trailing z-score of a series, over a window of `windowBars` bars.
 *
 * Running sums, so the cost is one pass regardless of window size: at 5m a
 * thirty-day window is 8,640 bars and a naive recompute per bar would be
 * quadratic over the 800,000-bar dataset.
 *
 * NaN entries take part in neither the mean nor the count, so a gap in the
 * input thins the window instead of poisoning it, and a bar whose own value
 * is NaN stays NaN. A window with no spread returns NaN rather than 0: a
 * constant funding rate has no z-score, and reporting 0 would read as
 * "exactly average" on what is really "no information".
 */
export function trailingZScore(series: Float64Array, windowBars: number, minSamples: number): Float64Array {
  const n = series.length;
  const out = new Float64Array(n).fill(NaN);
  let count = 0;
  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < n; i++) {
    const entering = series[i];
    if (Number.isFinite(entering)) {
      count++;
      sum += entering;
      sumSq += entering * entering;
    }

    const leavingIndex = i - windowBars;
    if (leavingIndex >= 0) {
      const leaving = series[leavingIndex];
      if (Number.isFinite(leaving)) {
        count--;
        sum -= leaving;
        sumSq -= leaving * leaving;
      }
    }

    const value = series[i];
    if (!Number.isFinite(value) || count < minSamples) continue;

    const mean = sum / count;
    const meanSq = mean * mean;
    // Sample variance, matching realizedVol20's ddof of 1.
    const variance = (sumSq - count * meanSq) / (count - 1);

    // sumSq and count*meanSq are nearly equal for a near-constant series, so
    // their difference is pure cancellation noise there: a constant funding
    // rate would otherwise get a standard deviation around 1e-12 and a z-score
    // of arbitrary size. Anything at or below the scale of that noise counts as
    // no spread, which is NaN rather than 0: a series that never moves has no
    // z-score, and 0 would read as "exactly average".
    const epsilon = 1e-12 * Math.max(sumSq / count, meanSq, Number.MIN_VALUE);
    if (variance <= epsilon) continue;

    out[i] = (value - mean) / Math.sqrt(variance);
  }

  return out;
}

/** Index rows by timestamp for an exact-bar join, never carrying a stale bar forward. */
function byTimestamp<T extends { t: number }>(rows: T[] | null | undefined): Map<number, T> {
  const map = new Map<number, T>();
  for (const row of rows ?? []) map.set(row.t, row);
  return map;
}

/** Log change of a per-bar series over `lookback` bars, NaN unless both ends are positive. */
function logChange(series: Float64Array, bar: number, lookback: number): number {
  if (bar < lookback) return NaN;
  const now = series[bar];
  const then = series[bar - lookback];
  if (!Number.isFinite(now) || !Number.isFinite(then) || now <= 0 || then <= 0) return NaN;
  return Math.log(now / then);
}

/**
 * Change in signed book depth over one bar, scaled by current depth.
 *
 * The banded analogue of order-flow imbalance (Cont, Kukanov and Stoikov 2014),
 * whose result is that price changes are approximately linear in flow scaled by
 * depth. True OFI needs best-quote updates, which do not exist for UM futures
 * (`bookTicker` serves no files), so this is explicitly a banded proxy.
 *
 * No reconstruction of each side is needed. With `N` the notional on both sides
 * and `I` the imbalance, `bid - ask = N * I` identically, so
 * `(B_t - B_{t-1}) - (A_t - A_{t-1})` collapses to `N_t*I_t - N_{t-1}*I_{t-1}`.
 *
 * One documented approximation: `depthNotional1` and `depthImbalance1` are each
 * a mean over the 5m slot's snapshots, so their product is not the mean of the
 * product unless the sum and the ratio are uncorrelated within the slot.
 * `depthSamples` records the snapshot count if that ever needs auditing.
 */
function depthFlow(signed: Float64Array, notional: Float64Array, bar: number): number {
  if (bar < 1) return NaN;
  const now = signed[bar];
  const then = signed[bar - 1];
  const scale = notional[bar];
  if (!Number.isFinite(now) || !Number.isFinite(then) || !Number.isFinite(scale) || scale <= 0) {
    return NaN;
  }
  return (now - then) / scale;
}

/** -1, 0 or 1; NaN propagates so a missing input never reads as "no divergence". */
function signOf(value: number): number {
  if (!Number.isFinite(value)) return NaN;
  return Math.sign(value);
}

function simpleReturn(candles: CandleRow[], bar: number, lookback: number): number {
  if (bar < lookback) return NaN;
  const prev = candles[bar - lookback].c;
  return (candles[bar].c - prev) / prev;
}

function realizedVol20(candles: CandleRow[], bar: number): number {
  if (bar < 20) return NaN;
  const logReturns: number[] = [];
  for (let k = bar - 19; k <= bar; k++) {
    logReturns.push(Math.log(candles[k].c / candles[k - 1].c));
  }
  const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
  const variance =
    logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance);
}

/**
 * Whether a category has no real input to score, matching what actually
 * determines `component.score` rather than the displayed `signals` list.
 * scoreVolatility (src/lib/signals/scorer.ts) excludes ATR -- a volatility
 * regime reading, not a directional signal -- from the score it computes,
 * but still lists ATR in `signals`, so volatility needs the same exclusion
 * here or a bar with only ATR would read as "has data" when it has none.
 */
function isCategoryDataMissing(component: SignalComponent): boolean {
  if (component.category === 'volatility') {
    return component.signals.filter((s) => s.name !== 'ATR').length === 0;
  }
  return component.signals.length === 0;
}

export function computeFactorMatrix(input: FactorMatrixInput): FactorMatrix {
  const { candles, snapshots, htf, interval, metrics, perp, premiumIndex } = input;
  const style = styleForInterval(interval);
  const profile = getStyleConfig(style);
  const weights = DEFAULT_TEMPLATE_WEIGHTS[style];

  // htf must be index-aligned with candles (one row per candle, same
  // timestamp) -- everything below reads htf[bar] positionally assuming
  // that invariant. A silent misalignment would attribute the wrong HTF
  // context to a bar without any error, so it is checked here rather than
  // trusted from the caller.
  if (htf.length !== candles.length) {
    throw new Error(
      `computeFactorMatrix: htf has ${htf.length} rows but candles has ${candles.length}`
    );
  }
  for (let i = 0; i < candles.length; i++) {
    if (htf[i].t !== candles[i].t) {
      throw new Error(
        `computeFactorMatrix: htf[${i}].t (${htf[i].t}) does not match candles[${i}].t (${candles[i].t})`
      );
    }
  }

  const ohlcv = candles.map(toOHLCV);
  const leanSnapshots = snapshots ? snapshots.map(toLeanSnapshot) : undefined;

  // No htfInput: HTF context is already precomputed per bar in `htf` (C1's export),
  // computed the same causal way (computeHtfSeries + alignHtfToLtf + htfContextAtBar).
  const prepared = prepareBacktest(ohlcv, '', interval, profile.config, leanSnapshots);
  const { indicators, superTrend, warmupBars, stOffset, snapshots: alignedSnapshots } = prepared;

  const n = candles.length;

  // One composite per bar, exactly as the optimized engine scores a bar --
  // same suite, snapshot inputs, SuperTrend, and HTF context -- but with the
  // style's DEFAULT_TEMPLATE_WEIGHTS rather than a BacktestConfig's weights.
  // Bars before warmupBars are never read below (every consumer starts its
  // own loop at warmupBars), so scoring them is discarded work skipped here.
  const composites: ReturnType<typeof computeSignalScore>[] = new Array(n);
  for (let bar = warmupBars; bar < n; bar++) {
    const suite = indicators[bar];
    const scoringSuite = style === 'scalping' ? excludeIchimokuForScalping(suite) : suite;
    const snap = alignedSnapshots?.[bar] ?? null;
    const htfCtx = htf[bar]?.context ?? null;

    const stIdx = bar - stOffset;
    const superTrendAtBar = stIdx >= 0 && stIdx < superTrend.length ? superTrend[stIdx] : undefined;

    composites[bar] = computeSignalScore(
      scoringSuite,
      snap?.futures ?? null,
      snap?.sentiment ?? null,
      weights,
      superTrendAtBar ? { values: superTrend, current: superTrendAtBar } : null,
      htfCtx
    );
  }

  // Discover every sig.<name> that fires on any post-warmup bar, in first-seen
  // order (category order, then encounter order within a category). Names
  // that never fire for this style/interval/data combination are simply
  // absent, rather than a column that is NaN for the whole series.
  const sigOrder: string[] = [];
  const sigCategory = new Map<string, string>();
  for (let bar = warmupBars; bar < n; bar++) {
    for (const component of composites[bar].components) {
      for (const sig of component.signals) {
        if (!sigCategory.has(sig.name)) {
          sigCategory.set(sig.name, component.category);
          sigOrder.push(sig.name);
        }
      }
    }
  }

  const names: string[] = [
    'composite',
    ...CATEGORY_ORDER.map((c) => `cat.${c}`),
    ...sigOrder.map((s) => `sig.${s}`),
    ...RAW_NAMES,
  ];
  const categories: string[] = [
    'composite',
    ...CATEGORY_ORDER,
    ...sigOrder.map((s) => sigCategory.get(s)!),
    ...RAW_NAMES.map(() => 'raw'),
  ];

  const values: Float64Array[] = names.map(() => new Float64Array(n).fill(NaN));
  const nameIndex = new Map<string, number>(names.map((name, i) => [name, i]));

  const compositeIdx = nameIndex.get('composite')!;
  const catIdx = new Map(CATEGORY_ORDER.map((c) => [c, nameIndex.get(`cat.${c}`)!]));
  const sigIdx = new Map(sigOrder.map((s) => [s, nameIndex.get(`sig.${s}`)!]));
  const rawIdx = new Map(RAW_NAMES.map((r) => [r, nameIndex.get(r)!]));

  // Archive inputs, aligned to these bars.
  //
  // The metrics grid is 5m native, so it is joined with the last reading at or
  // before each bar's CLOSE, not its open. A factor is read at the bar's close
  // (forwardReturns measures from closes[bar] onward), so a reading from
  // inside the bar is already published by the time the factor is used, and
  // taking the open instead would throw away most of an hour of information at
  // 1h. This is deliberately not the rule src/lib/backtest/snapshot-series.ts
  // applies to HistoricalSnapshot rows, which is pinned to the bar's open
  // because live snapshot ingestion runs on its own cron.
  const intervalMs = intervalToMs(interval);
  const barCloses = candles.map((candle) => candle.t + intervalMs - 1);
  const metricsStaleness = Math.max(intervalMs, 2 * METRICS_SLOT_MS);
  const alignedMetrics = metrics && metrics.length > 0
    ? alignToBars(barCloses, metrics.map((row) => ({ ...row, timestamp: row.t })), metricsStaleness)
    : null;

  // Perpetual bars share the candle grid, so they join on an exact timestamp
  // match: a missing perp bar is NaN, never the previous bar's price.
  const perpByTime = byTimestamp(perp);
  const premiumByTime = byTimestamp(premiumIndex);

  // Open interest per bar, needed as a series before its changes can be taken.
  const openInterestSeries = new Float64Array(n).fill(NaN);
  if (alignedMetrics) {
    for (let bar = 0; bar < n; bar++) {
      openInterestSeries[bar] = alignedMetrics[bar]?.openInterest ?? NaN;
    }
  }

  // Book depth per bar, needed as series before a change can be taken. `signed`
  // is bid minus ask, which is the notional times the imbalance.
  const depthNotionalSeries = new Float64Array(n).fill(NaN);
  const signedDepthSeries = new Float64Array(n).fill(NaN);
  if (alignedMetrics) {
    for (let bar = 0; bar < n; bar++) {
      const notional = alignedMetrics[bar]?.depthNotional1;
      const imbalance = alignedMetrics[bar]?.depthImbalance1;
      if (typeof notional === 'number' && Number.isFinite(notional)) {
        depthNotionalSeries[bar] = notional;
        if (typeof imbalance === 'number' && Number.isFinite(imbalance)) {
          signedDepthSeries[bar] = notional * imbalance;
        }
      }
    }
  }

  const fundingSeries = new Float64Array(n).fill(NaN);
  for (let bar = warmupBars; bar < n; bar++) {
    fundingSeries[bar] = alignedSnapshots?.[bar]?.futures?.fundingRate?.fundingRate ?? NaN;
  }
  const fundingZ = trailingZScore(
    fundingSeries,
    Math.max(1, Math.ceil((FUNDING_Z_DAYS * DAY_MS) / intervalMs)),
    FUNDING_Z_MIN_SAMPLES
  );

  for (let bar = warmupBars; bar < n; bar++) {
    const composite = composites[bar];
    values[compositeIdx][bar] = composite.score;

    for (const component of composite.components) {
      const idx = catIdx.get(component.category);
      if (idx !== undefined) {
        // Missing input (no futures/sentiment/htf data at this bar) -> NaN,
        // not the scorer's internal 0-for-redistribution default.
        values[idx][bar] = isCategoryDataMissing(component) ? NaN : component.score;
      }

      for (const sig of component.signals) {
        const sIdx = sigIdx.get(sig.name);
        if (sIdx !== undefined) {
          const multiplier = sig.direction === 'bullish' ? 1 : sig.direction === 'bearish' ? -1 : 0;
          values[sIdx][bar] = multiplier * sig.strength;
        }
      }
    }

    const suite = indicators[bar];
    const candle = candles[bar];
    const snap = alignedSnapshots?.[bar] ?? null;
    const htfCtx = htf[bar]?.context ?? null;

    values[rawIdx.get('raw.rsi')!][bar] = suite.rsi.current;
    values[rawIdx.get('raw.emaSpreadPct')!][bar] =
      ((suite.ema12.current - suite.ema26.current) / suite.ema26.current) * 100;
    values[rawIdx.get('raw.atrPct')!][bar] = (suite.atr.current / candle.c) * 100;
    values[rawIdx.get('raw.fundingRate')!][bar] = snap?.futures?.fundingRate?.fundingRate ?? NaN;
    values[rawIdx.get('raw.longShortRatio')!][bar] =
      snap?.futures?.longShortRatio?.longShortRatio ?? NaN;
    values[rawIdx.get('raw.takerBuyRatio')!][bar] =
      candle.tbv !== null && candle.v !== 0 ? candle.tbv / candle.v : NaN;
    values[rawIdx.get('raw.fearGreed')!][bar] = snap?.sentiment?.fearGreedIndex ?? NaN;
    // A null context is a missing input (no confirmation interval, e.g. 1d,
    // or the HTF's own warmup not yet satisfied) -> NaN, distinct from a
    // real 'neutral' trend reading, which is 0.
    values[rawIdx.get('raw.htfTrend')!][bar] = !htfCtx
      ? NaN
      : htfCtx.trendDirection === 'bullish'
        ? 1
        : htfCtx.trendDirection === 'bearish'
          ? -1
          : 0;
    values[rawIdx.get('raw.ret1')!][bar] = simpleReturn(candles, bar, 1);
    values[rawIdx.get('raw.ret5')!][bar] = simpleReturn(candles, bar, 5);
    values[rawIdx.get('raw.ret20')!][bar] = simpleReturn(candles, bar, 20);
    values[rawIdx.get('raw.realizedVol20')!][bar] = realizedVol20(candles, bar);

    const metric = alignedMetrics?.[bar] ?? null;
    const oiChange1 = logChange(openInterestSeries, bar, 1);
    values[rawIdx.get('raw.oiChange1')!][bar] = oiChange1;
    values[rawIdx.get('raw.oiChange8')!][bar] = logChange(openInterestSeries, bar, 8);
    // Positions building into a move against positions covering out of one.
    // NaN in either leg propagates, so "no divergence" is never inferred from
    // a missing reading.
    values[rawIdx.get('raw.oiPriceDiv')!][bar] =
      signOf(oiChange1) * signOf(simpleReturn(candles, bar, 1));
    values[rawIdx.get('raw.takerLongShortRatio')!][bar] = metric?.takerLongShortRatio ?? NaN;
    values[rawIdx.get('raw.topTraderPositionRatio')!][bar] = metric?.topTraderPositionRatio ?? NaN;
    values[rawIdx.get('raw.globalAccountRatio')!][bar] = metric?.globalAccountRatio ?? NaN;
    values[rawIdx.get('raw.depthImbalance1')!][bar] = metric?.depthImbalance1 ?? NaN;
    values[rawIdx.get('raw.depthImbalance5')!][bar] = metric?.depthImbalance5 ?? NaN;
    values[rawIdx.get('raw.depthNotional1')!][bar] = metric?.depthNotional1 ?? NaN;
    // How much thicker the book is out at 5% than at 1%: where liquidity sits
    // is a direct expected-slippage reading, and nothing else here measures it.
    const notional1 = metric?.depthNotional1;
    const notional5 = metric?.depthNotional5;
    values[rawIdx.get('raw.depthSlope')!][bar] =
      typeof notional1 === 'number' &&
      typeof notional5 === 'number' &&
      Number.isFinite(notional1) &&
      Number.isFinite(notional5) &&
      notional1 > 0
        ? (notional5 - notional1) / notional1
        : NaN;
    values[rawIdx.get('raw.depthFlow1')!][bar] = depthFlow(
      signedDepthSeries,
      depthNotionalSeries,
      bar
    );

    values[rawIdx.get('raw.fundingZ')!][bar] = fundingZ[bar];

    // The premium index close is the perp-to-index premium as a fraction.
    const premiumBar = premiumByTime.get(candle.t);
    values[rawIdx.get('raw.basisPct')!][bar] = premiumBar ? premiumBar.c * 100 : NaN;

    // What the venue mismatch is worth at this bar: candles/ holds SPOT closes
    // while every backtest charges perpetual costs.
    const perpBar = perpByTime.get(candle.t);
    values[rawIdx.get('raw.perpSpotSpreadPct')!][bar] =
      perpBar && candle.c !== 0 ? ((perpBar.c - candle.c) / candle.c) * 100 : NaN;
  }

  return {
    names,
    categories,
    values,
    warmupBars,
    timestamps: candles.map((c) => c.t),
    closes: candles.map((c) => c.c),
  };
}
