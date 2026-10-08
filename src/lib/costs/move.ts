import { intervalToMs } from '@/lib/intervals';

/**
 * The move a hold of a given length actually makes, measured close to close
 * on recent bars. This is the yardstick a round-trip cost is compared
 * against: a trade's gross result over its hold is some fraction of this
 * move, so a cost that is a large share of it leaves nothing to win.
 *
 * Why close to close and not the median true range: true range includes the
 * bar's high-low span, roughly 1.5 to 2 times a close-to-close move, and
 * scaling it by the square root of the hold assumes a random walk. Both make
 * costs look smaller than they are.
 */

/** Kline intervals a hold can be measured on, finest first. */
export const MEASUREMENT_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type MeasurementInterval = (typeof MEASUREMENT_INTERVALS)[number];

/** A hold is measured on bars at least this many times shorter than itself. */
export const MIN_BARS_PER_HOLD = 3;

export const MIN_HOLD_MS = 60_000;

export interface Measurement {
  interval: MeasurementInterval;
  holdBars: number;
  /** The hold actually measured: holdBars whole bars, which the UI shows. */
  measuredHoldMs: number;
}

/**
 * The coarsest interval that still fits at least three bars into the hold,
 * so a 5-minute scalp is measured on 1m bars and a week on daily bars. A
 * hold shorter than three minutes falls back to 1m bars. The hold is
 * rounded to whole bars.
 */
export function pickMeasurementInterval(holdMs: number): Measurement {
  if (!(holdMs >= MIN_HOLD_MS)) throw new Error(`A hold must be at least ${MIN_HOLD_MS / 60_000} minute`);
  let chosen: MeasurementInterval = '1m';
  for (const interval of MEASUREMENT_INTERVALS) {
    if (holdMs / intervalToMs(interval) >= MIN_BARS_PER_HOLD) chosen = interval;
  }
  const barMs = intervalToMs(chosen);
  const holdBars = Math.max(1, Math.round(holdMs / barMs));
  return { interval: chosen, holdBars, measuredHoldMs: holdBars * barMs };
}

export interface HoldMoveStats {
  /** Median absolute return over the hold, percent. "Typical". */
  medianPercent: number;
  /** Mean absolute return, winsorised at the 99th percentile, percent. Used for breakeven. */
  meanPercent: number;
  /** 75th percentile, percent: one hold in four moves more than this. */
  p75Percent: number;
  /** Overlapping windows measured. */
  samples: number;
  /** Non-overlapping windows the figures rest on. */
  independentWindows: number;
}

/** Linear interpolation between order statistics (the usual "type 7" quantile). */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Absolute simple returns |close[i + h] / close[i] - 1| over every
 * overlapping window of `holdBars` bars. The mean is winsorised at the 99th
 * percentile so one crash bar does not set it. Null when the series is too
 * short for a single window.
 */
export function holdMoveStats(closes: readonly number[], holdBars: number): HoldMoveStats | null {
  if (!Number.isInteger(holdBars) || holdBars < 1) throw new Error('holdBars must be a positive integer');
  const moves: number[] = [];
  for (let i = 0; i + holdBars < closes.length; i++) {
    const from = closes[i];
    const to = closes[i + holdBars];
    if (from > 0 && Number.isFinite(to)) moves.push(Math.abs(to / from - 1));
  }
  if (moves.length === 0) return null;
  moves.sort((a, b) => a - b);
  const cap = quantileSorted(moves, 0.99);
  const mean = moves.reduce((sum, m) => sum + Math.min(m, cap), 0) / moves.length;
  return {
    medianPercent: quantileSorted(moves, 0.5) * 100,
    meanPercent: mean * 100,
    p75Percent: quantileSorted(moves, 0.75) * 100,
    samples: moves.length,
    independentWindows: Math.floor((closes.length - 1) / holdBars),
  };
}
