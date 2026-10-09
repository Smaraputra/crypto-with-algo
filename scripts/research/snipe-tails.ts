/**
 * Snipe phase tail thresholds and ATR quintiles (see snipe.ts, TAILS and STATISTIC). Pure, no I/O.
 *
 * Rules:
 *   - Thresholds are recomputed at each UTC calendar month start M from the FINITE values with timestamp in
 *     [M - lookbackDays, M), strictly before M, so a bar never sees its own month. A bar uses its own month's thresholds.
 *   - Quantile is linear interpolation between order statistics (type 7, the numpy default):
 *     h = (n - 1) p, x[floor h] + (h - floor h) (x[floor h + 1] - x[floor h]).
 *   - A month has NO thresholds (null) unless the window holds at least half of its expected bar count,
 *     expected = lookbackDays x 86,400,000 / intervalMs. This also covers "no thresholds before the history exists".
 *   - `timestamps` must be sorted ascending (bar open ms), parallel to `values`.
 *
 * Tail flag encoding: one Uint8Array, one byte per bar, OR of TAIL_TOP_1, TAIL_BOTTOM_1, TAIL_TOP_10, TAIL_BOTTOM_10,
 * plus TAIL_ELIGIBLE on every bar that was evaluated (finite value and thresholds for its month).
 * A bar with a non-finite value, or in a month without thresholds, has byte 0.
 */

const DAY_MS = 86_400_000;

export const TAIL_TOP_1 = 1;
export const TAIL_BOTTOM_1 = 2;
export const TAIL_TOP_10 = 4;
export const TAIL_BOTTOM_10 = 8;
/** Set on every bar whose value is finite and whose month has thresholds. */
export const TAIL_ELIGIBLE = 16;

/** Probabilities tailFlags expects the thresholds to hold, in this order: q01, q10, q90, q99. */
export const TAIL_PROBS = [0.01, 0.1, 0.9, 0.99] as const;
/** Probabilities atrQuintiles uses. */
export const QUINTILE_PROBS = [0.2, 0.4, 0.6, 0.8] as const;

/** Thresholds per UTC month start (ms), one value per prob, or null when the window is too thin. */
export type MonthlyThresholds = Map<number, Float64Array | null>;

/** UTC year x 12 + month, for strata. */
export function monthIndex(ms: number): number {
  const d = new Date(ms);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** Start of the UTC calendar month containing `ms`. */
export function monthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Type 7 quantile of an ascending-sorted array. */
function quantileSorted(sorted: Float64Array, p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  if (lo + 1 >= sorted.length) return sorted[sorted.length - 1];
  return sorted[lo] + (h - lo) * (sorted[lo + 1] - sorted[lo]);
}

/** First index with timestamp >= ms. */
function lowerBound(timestamps: ArrayLike<number>, ms: number): number {
  let lo = 0;
  let hi = timestamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timestamps[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function monthlyThresholds(
  timestamps: ArrayLike<number>,
  values: ArrayLike<number>,
  probs: readonly number[],
  lookbackDays: number,
  intervalMs: number,
): MonthlyThresholds {
  const out: MonthlyThresholds = new Map();
  const expected = (lookbackDays * DAY_MS) / intervalMs;
  const lookbackMs = lookbackDays * DAY_MS;
  for (let i = 0; i < timestamps.length; i++) {
    const m = monthStart(timestamps[i]);
    if (out.has(m)) continue;
    const from = lowerBound(timestamps, m - lookbackMs);
    const to = lowerBound(timestamps, m);
    const window: number[] = [];
    for (let k = from; k < to; k++) if (Number.isFinite(values[k])) window.push(values[k]);
    if (window.length === 0 || window.length < expected / 2) {
      out.set(m, null);
      continue;
    }
    const sorted = Float64Array.from(window).sort();
    out.set(m, Float64Array.from(probs, (p) => quantileSorted(sorted, p)));
  }
  return out;
}

/** Tail flag bytes (see the header). `thresholds` must hold TAIL_PROBS in order. */
export function tailFlags(
  timestamps: ArrayLike<number>,
  values: ArrayLike<number>,
  thresholds: MonthlyThresholds,
): Uint8Array {
  const out = new Uint8Array(timestamps.length);
  for (let i = 0; i < timestamps.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const q = thresholds.get(monthStart(timestamps[i]));
    if (!q) continue;
    let f = TAIL_ELIGIBLE;
    if (v >= q[3]) f |= TAIL_TOP_1;
    if (v <= q[0]) f |= TAIL_BOTTOM_1;
    if (v >= q[2]) f |= TAIL_TOP_10;
    if (v <= q[1]) f |= TAIL_BOTTOM_10;
    out[i] = f;
  }
  return out;
}

/** Quintile 0..4 of each bar's ATR% within its symbol's trailing window; -1 when not finite or no thresholds. */
export function atrQuintiles(
  timestamps: ArrayLike<number>,
  atrPct: ArrayLike<number>,
  lookbackDays: number,
  intervalMs: number,
): Int8Array {
  const th = monthlyThresholds(timestamps, atrPct, QUINTILE_PROBS, lookbackDays, intervalMs);
  const out = new Int8Array(timestamps.length).fill(-1);
  for (let i = 0; i < timestamps.length; i++) {
    const v = atrPct[i];
    if (!Number.isFinite(v)) continue;
    const q = th.get(monthStart(timestamps[i]));
    if (!q) continue;
    out[i] = v <= q[0] ? 0 : v <= q[1] ? 1 : v <= q[2] ? 2 : v <= q[3] ? 3 : 4;
  }
  return out;
}
