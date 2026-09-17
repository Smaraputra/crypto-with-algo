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
 */

import type { TradingStyle } from '@/lib/models/signal-template';
import { DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import type { SignalWeights } from '@/types/signal';
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

function styleForInterval(interval: string): TradingStyle {
  const style = STYLE_FOR_INTERVAL[interval];
  if (!style) {
    throw new Error(`No trading style mapped for interval "${interval}"`);
  }
  return style;
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

export function computeFactorMatrix(input: FactorMatrixInput): FactorMatrix {
  const { candles, snapshots, htf, interval } = input;
  const style = styleForInterval(interval);
  const profile = getStyleConfig(style);
  const weights = DEFAULT_TEMPLATE_WEIGHTS[style];

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
  const composites: ReturnType<typeof computeSignalScore>[] = new Array(n);
  for (let bar = 0; bar < n; bar++) {
    const suite = indicators[bar];
    const snap = alignedSnapshots?.[bar] ?? null;
    const htfCtx = htf[bar]?.context ?? null;

    const stIdx = bar - stOffset;
    const superTrendAtBar = stIdx >= 0 && stIdx < superTrend.length ? superTrend[stIdx] : undefined;

    composites[bar] = computeSignalScore(
      suite,
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
        values[idx][bar] = component.signals.length > 0 ? component.score : NaN;
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
    values[rawIdx.get('raw.htfTrend')!][bar] = !htfCtx
      ? 0
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
