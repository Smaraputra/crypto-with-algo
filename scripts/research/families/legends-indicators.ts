/**
 * Causal indicator series for the legends phase's harness families (P1 to P4,
 * C1, C2), computed once per candle array and cached by array identity, so a
 * family can read the value at `ctx.bar` without recomputing the history on
 * every bar. The value at index i reads candles 0..i only.
 *
 * The suite in `ctx.suite` is not used: at 1d its `sma200` is a 400-bar
 * average and it carries no ADX (plan B3), so every legend rule computes its
 * own inputs from the textbook definitions below.
 *
 * Definitions:
 *   TR_i        max(high - low, |high - close_{i-1}|, |low - close_{i-1}|), from i = 1
 *   Wilder(n)   seeded with the mean of the first n values, then
 *               x_i = ((n - 1) x_{i-1} + v_i) / n
 *   ATR(14)     Wilder(14) of TR
 *   Turtle N    Wilder(20) of TR (Faith: N = (19 N_{t-1} + TR_t) / 20, seeded by a 20-day mean)
 *   RSI(14)     Wilder(14) of gains and of losses; 100 - 100 / (1 + avgGain / avgLoss), 100 with no loss
 *   EMA(20)     seeded with the 20-bar simple mean, alpha 2 / 21
 *   ADX(14)     Wilder's: +DM / -DM / TR summed over 14 bars then smoothed S - S/14 + x;
 *               DI = 100 x DM / TR; DX = 100 |+DI - -DI| / (+DI + -DI); ADX = Wilder(14) of DX
 *   Bollinger   n-bar simple mean of closes +/- k population standard deviations
 */
import type { OHLCV } from '@/types/market';
import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { BacktestConfig } from '@/lib/backtest/types';

const cache = new WeakMap<readonly OHLCV[], Map<string, Float64Array>>();

/** The series `key` for `candles`, computed once per array. */
export function cached(candles: readonly OHLCV[], key: string, compute: () => Float64Array): Float64Array {
  let byKey = cache.get(candles);
  if (!byKey) {
    byKey = new Map();
    cache.set(candles, byKey);
  }
  let series = byKey.get(key);
  if (!series) {
    series = compute();
    byKey.set(key, series);
  }
  return series;
}

function nanArray(n: number): Float64Array {
  return new Float64Array(n).fill(Number.NaN);
}

export function trueRange(c: readonly OHLCV[]): Float64Array {
  const out = nanArray(c.length);
  for (let i = 1; i < c.length; i++) {
    const prev = c[i - 1].close;
    out[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - prev), Math.abs(c[i].low - prev));
  }
  return out;
}

/** Wilder smoothing of `values` defined from `first`: seeded at first + n - 1 with the mean of n values. */
export function wilder(values: Float64Array, n: number, first: number): Float64Array {
  const out = nanArray(values.length);
  const seedAt = first + n - 1;
  if (seedAt >= values.length) return out;
  let sum = 0;
  for (let i = first; i <= seedAt; i++) sum += values[i];
  out[seedAt] = sum / n;
  for (let i = seedAt + 1; i < values.length; i++) out[i] = ((n - 1) * out[i - 1] + values[i]) / n;
  return out;
}

export function atr(c: readonly OHLCV[], n = 14): Float64Array {
  return cached(c, `atr${n}`, () => wilder(trueRange(c), n, 1));
}

export function turtleN(c: readonly OHLCV[]): Float64Array {
  return cached(c, 'turtleN', () => wilder(trueRange(c), 20, 1));
}

export function rsi(c: readonly OHLCV[], n = 14): Float64Array {
  return cached(c, `rsi${n}`, () => {
    const gains = new Float64Array(c.length);
    const losses = new Float64Array(c.length);
    for (let i = 1; i < c.length; i++) {
      const d = c[i].close - c[i - 1].close;
      gains[i] = d > 0 ? d : 0;
      losses[i] = d < 0 ? -d : 0;
    }
    const g = wilder(gains, n, 1);
    const l = wilder(losses, n, 1);
    const out = nanArray(c.length);
    for (let i = 0; i < c.length; i++) {
      if (!Number.isFinite(g[i]) || !Number.isFinite(l[i])) continue;
      out[i] = l[i] === 0 ? 100 : 100 - 100 / (1 + g[i] / l[i]);
    }
    return out;
  });
}

export function ema(c: readonly OHLCV[], n = 20): Float64Array {
  return cached(c, `ema${n}`, () => {
    const out = nanArray(c.length);
    if (c.length < n) return out;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += c[i].close;
    out[n - 1] = sum / n;
    const alpha = 2 / (n + 1);
    for (let i = n; i < c.length; i++) out[i] = out[i - 1] + alpha * (c[i].close - out[i - 1]);
    return out;
  });
}

export interface AdxSeries {
  adx: Float64Array;
  plusDi: Float64Array;
  minusDi: Float64Array;
}

const adxCache = new WeakMap<readonly OHLCV[], Map<number, AdxSeries>>();

export function adx(c: readonly OHLCV[], n = 14): AdxSeries {
  let byN = adxCache.get(c);
  if (!byN) {
    byN = new Map();
    adxCache.set(c, byN);
  }
  const hit = byN.get(n);
  if (hit) return hit;

  const len = c.length;
  const tr = trueRange(c);
  const plusDm = new Float64Array(len);
  const minusDm = new Float64Array(len);
  for (let i = 1; i < len; i++) {
    const up = c[i].high - c[i - 1].high;
    const down = c[i - 1].low - c[i].low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  const plusDi = nanArray(len);
  const minusDi = nanArray(len);
  const dx = nanArray(len);
  let sTr = 0;
  let sPlus = 0;
  let sMinus = 0;
  for (let i = 1; i < len; i++) {
    if (i <= n) {
      sTr += tr[i];
      sPlus += plusDm[i];
      sMinus += minusDm[i];
      if (i < n) continue;
    } else {
      sTr = sTr - sTr / n + tr[i];
      sPlus = sPlus - sPlus / n + plusDm[i];
      sMinus = sMinus - sMinus / n + minusDm[i];
    }
    plusDi[i] = sTr > 0 ? (100 * sPlus) / sTr : 0;
    minusDi[i] = sTr > 0 ? (100 * sMinus) / sTr : 0;
    const total = plusDi[i] + minusDi[i];
    dx[i] = total > 0 ? (100 * Math.abs(plusDi[i] - minusDi[i])) / total : 0;
  }
  const series: AdxSeries = { adx: wilder(dx, n, n), plusDi, minusDi };
  byN.set(n, series);
  return series;
}

export interface BollingerSeries {
  middle: Float64Array;
  upper: Float64Array;
  lower: Float64Array;
}

const bbCache = new WeakMap<readonly OHLCV[], Map<string, BollingerSeries>>();

export function bollinger(c: readonly OHLCV[], n: number, k: number): BollingerSeries {
  const key = `${n}:${k}`;
  let byKey = bbCache.get(c);
  if (!byKey) {
    byKey = new Map();
    bbCache.set(c, byKey);
  }
  const hit = byKey.get(key);
  if (hit) return hit;
  const middle = nanArray(c.length);
  const upper = nanArray(c.length);
  const lower = nanArray(c.length);
  for (let i = n - 1; i < c.length; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += c[j].close;
    const mean = sum / n;
    let sq = 0;
    for (let j = i - n + 1; j <= i; j++) sq += (c[j].close - mean) ** 2;
    const sd = Math.sqrt(sq / n);
    middle[i] = mean;
    upper[i] = mean + k * sd;
    lower[i] = mean - k * sd;
  }
  const series = { middle, upper, lower };
  byKey.set(key, series);
  return series;
}

/** Highest high of bars from..to inclusive. */
export function highest(c: readonly OHLCV[], from: number, to: number): number {
  let out = -Infinity;
  for (let i = from; i <= to; i++) if (c[i].high > out) out = c[i].high;
  return out;
}

/** Lowest low of bars from..to inclusive. */
export function lowest(c: readonly OHLCV[], from: number, to: number): number {
  let out = Infinity;
  for (let i = from; i <= to; i++) if (c[i].low < out) out = c[i].low;
  return out;
}

/**
 * The random-entry null's entry mechanism for the legends families: the null's
 * market decision (a fill at the decision close) becomes a next-open fill with
 * the same stop and target distances measured from the fill. Every legends
 * harness rule enters at a later bar's open or inside it, never at the
 * decision close, so a null filled at the close would be timed differently
 * from its reference. Stop-entry rules (P1 to P4) are matched on the next open
 * too: a breakout trigger has no meaning for a random entry.
 */
export function nextOpenEntryWrapper(inner: Strategy): Strategy {
  return {
    ...inner,
    decideEntry(ctx: StrategyContext, config: BacktestConfig): EntryDecision | null {
      const decision = inner.decideEntry(ctx, config);
      if (!decision || decision.orderType !== 'market') return decision;
      const close = ctx.candles[ctx.bar].close;
      return {
        ...decision,
        orderType: 'next-open',
        fillRelative: {
          stopFraction: Math.abs(close - decision.stopPrice) / close,
          ...(decision.targetPrice !== null ? { targetFraction: Math.abs(decision.targetPrice - close) / close } : {}),
        },
      };
    },
  };
}
