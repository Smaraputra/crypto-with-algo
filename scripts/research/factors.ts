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
import type { CandleRow, HtfRow, SnapshotRow } from './dataset-format';

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

function toOHLCV(row: CandleRow): OHLCV {
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
function toLeanSnapshot(row: SnapshotRow): LeanSnapshot {
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
] as const;

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
  const { candles, snapshots, htf, interval } = input;
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
