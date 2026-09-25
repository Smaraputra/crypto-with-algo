/**
 * Stationary block bootstrap (Politis & Romano, 1994) and a percentile
 * confidence interval built on top of it, for resampling correlated time
 * series such as trade returns or daily PnL.
 */

import { createSeededRandom } from './seeded-random';

/**
 * One resample of length n as a list of source indices into the original
 * series. Starts at a random index; each subsequent index continues the
 * current block (previous index + 1, wrapping around n) with probability
 * 1 - 1/meanBlockLen, otherwise jumps to a new random start.
 */
export function stationaryBlockBootstrapIndices(
  n: number,
  meanBlockLen: number,
  random: () => number
): number[] {
  const continueProbability = 1 - 1 / meanBlockLen;
  const indices: number[] = new Array(n);

  let current = Math.floor(random() * n);
  indices[0] = current;

  for (let i = 1; i < n; i++) {
    if (random() < continueProbability) {
      current = (current + 1) % n;
    } else {
      current = Math.floor(random() * n);
    }
    indices[i] = current;
  }

  return indices;
}

/** Arithmetic mean of an array of numbers. */
export function meanOf(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function percentile(sorted: number[], p: number): number {
  const index = p * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Percentile bootstrap confidence interval for an arbitrary statistic over a
 * series, using the stationary block bootstrap to preserve autocorrelation.
 */
export function bootstrapCi(
  series: number[],
  statistic: (sample: number[]) => number,
  opts: { iterations: number; meanBlockLen: number; seed: number; alpha?: number }
): { point: number; low: number; high: number; samples: number } {
  const { iterations, meanBlockLen, seed, alpha = 0.05 } = opts;
  const random = createSeededRandom(seed);
  const n = series.length;

  const point = statistic(series);

  const draws: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const indices = stationaryBlockBootstrapIndices(n, meanBlockLen, random);
    const sample = indices.map((idx) => series[idx]);
    draws[i] = statistic(sample);
  }
  draws.sort((a, b) => a - b);

  const low = percentile(draws, alpha / 2);
  const high = percentile(draws, 1 - alpha / 2);

  return { point, low, high, samples: iterations };
}

/**
 * Percentile bootstrap CI for a statistic over a series whose observations are
 * grouped into contiguous time buckets, resampling whole buckets rather than
 * individual observations.
 *
 * Why this exists next to bootstrapCi: bootstrapCi resamples a flat series, so
 * it preserves dependence along ONE axis. Panel data -- the same timestamp
 * observed across ten symbols -- is dependent along two. Ten symbols at one
 * bar move together, so flattening them into one series and block-resampling
 * that treats the cross-section as ten independent draws and shrinks the
 * interval by roughly sqrt(10). Passing one bucket per timestamp, each holding
 * that timestamp's whole cross-section, keeps both dependencies: the block
 * structure carries the serial correlation, and a bucket moving as a unit
 * carries the contemporaneous correlation.
 *
 * `meanBlockLen` is counted in BUCKETS, not observations, and should come from
 * the horizon over which observations overlap -- never from a cbrt(n) rule of
 * thumb calibrated on independent trades, which is badly undersized on
 * bar-frequency data and manufactures intervals that are too narrow.
 */
export function groupedBlockBootstrapCi(
  groups: number[][],
  statistic: (sample: number[]) => number,
  opts: { iterations: number; meanBlockLen: number; seed: number; alpha?: number }
): { point: number; low: number; high: number; samples: number; buckets: number } {
  const { iterations, meanBlockLen, seed, alpha = 0.05 } = opts;
  const random = createSeededRandom(seed);
  const nBuckets = groups.length;

  const flat = groups.flat();
  const point = statistic(flat);

  const draws: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const indices = stationaryBlockBootstrapIndices(nBuckets, meanBlockLen, random);
    const sample: number[] = [];
    for (const idx of indices) {
      for (const value of groups[idx]) sample.push(value);
    }
    draws[i] = statistic(sample);
  }
  draws.sort((a, b) => a - b);

  return {
    point,
    low: percentile(draws, alpha / 2),
    high: percentile(draws, 1 - alpha / 2),
    samples: iterations,
    buckets: nBuckets,
  };
}

/**
 * Max peak-to-trough drawdown of the equity path built by accumulating pnls
 * onto startEquity, expressed as a percent of the peak (e.g. 12.5 for 12.5%).
 * Throws RangeError for startEquity <= 0: zero or negative starting equity
 * has no meaningful "percent of the peak", and silently returning 0 would
 * read as "no drawdown" to a validation gate rather than as invalid input.
 */
export function maxDrawdownPercentOfPnl(pnls: number[], startEquity: number): number {
  if (startEquity <= 0) {
    throw new RangeError('maxDrawdownPercentOfPnl: startEquity must be > 0');
  }

  let equity = startEquity;
  let peak = startEquity;
  let maxDrawdown = 0;

  for (const pnl of pnls) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return maxDrawdown * 100;
}
