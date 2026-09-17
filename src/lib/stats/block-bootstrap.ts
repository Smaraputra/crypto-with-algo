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
 * Max peak-to-trough drawdown of the equity path built by accumulating pnls
 * onto startEquity, expressed as a percent of the peak (e.g. 12.5 for 12.5%).
 */
export function maxDrawdownPercentOfPnl(pnls: number[], startEquity: number): number {
  let equity = startEquity;
  let peak = startEquity;
  let maxDrawdown = 0;

  for (const pnl of pnls) {
    equity += pnl;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const drawdown = (peak - equity) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
  }

  return maxDrawdown * 100;
}
