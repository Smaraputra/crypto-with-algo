import { describe, it, expect } from 'vitest';
import { createSeededRandom } from './seeded-random';
import {
  stationaryBlockBootstrapIndices,
  bootstrapCi,
  groupedBlockBootstrapCi,
  meanOf,
  maxDrawdownPercentOfPnl,
} from './block-bootstrap';

describe('block-bootstrap', () => {
  describe('stationaryBlockBootstrapIndices', () => {
    it('returns n indices, each within [0, n)', () => {
      const random = createSeededRandom(1);
      const indices = stationaryBlockBootstrapIndices(50, 5, random);
      expect(indices).toHaveLength(50);
      for (const idx of indices) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(50);
        expect(Number.isInteger(idx)).toBe(true);
      }
    });

    it('matches pinned indices for a fixed seed (regression against the algorithm)', () => {
      const random = createSeededRandom(1);
      const indices = stationaryBlockBootstrapIndices(10, 3, random);
      expect(indices.slice(0, 8)).toEqual([6, 7, 8, 9, 0, 1, 4, 4]);
    });

    it('produces run lengths whose mean is close to meanBlockLen over many draws', () => {
      const random = createSeededRandom(99);
      const meanBlockLen = 8;
      const n = 4000;
      const indices = stationaryBlockBootstrapIndices(n, meanBlockLen, random);

      // A run is a maximal stretch where each index continues the previous one (mod n).
      const runLengths: number[] = [];
      let currentRun = 1;
      for (let i = 1; i < indices.length; i++) {
        const isContinuation = indices[i] === (indices[i - 1] + 1) % n;
        if (isContinuation) {
          currentRun++;
        } else {
          runLengths.push(currentRun);
          currentRun = 1;
        }
      }
      runLengths.push(currentRun);

      const observedMean = runLengths.reduce((s, v) => s + v, 0) / runLengths.length;
      // Geometric-ish run length; allow generous tolerance given randomness.
      expect(observedMean).toBeGreaterThan(meanBlockLen * 0.5);
      expect(observedMean).toBeLessThan(meanBlockLen * 1.5);
    });
  });

  describe('meanOf', () => {
    it('computes the arithmetic mean', () => {
      expect(meanOf([1, 2, 3, 4, 5])).toBeCloseTo(3, 10);
      expect(meanOf([2, 2, 2])).toBeCloseTo(2, 10);
      expect(meanOf([-1, 1])).toBeCloseTo(0, 10);
    });
  });

  describe('bootstrapCi', () => {
    it('is deterministic for a fixed seed', () => {
      const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const opts = { iterations: 200, meanBlockLen: 3, seed: 42 };
      const a = bootstrapCi(series, meanOf, opts);
      const b = bootstrapCi(series, meanOf, opts);
      expect(a).toEqual(b);
    });

    it('matches pinned low/high for a fixed seed (regression against the algorithm)', () => {
      const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const result = bootstrapCi(series, meanOf, { iterations: 200, meanBlockLen: 3, seed: 42 });
      expect(result.low).toBe(3.5);
      expect(result.high).toBe(7.2);
    });

    it('reports point as statistic(series) and samples as iterations', () => {
      const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const result = bootstrapCi(series, meanOf, { iterations: 150, meanBlockLen: 3, seed: 7 });
      expect(result.point).toBeCloseTo(meanOf(series), 10);
      expect(result.samples).toBe(150);
      expect(result.low).toBeLessThanOrEqual(result.high);
    });

    it('narrows and contains the true mean as iterations grow, for a series with known mean', () => {
      // A large, low-variance series with a known mean.
      const random = createSeededRandom(2024);
      const series = Array.from({ length: 500 }, () => 10 + (random() - 0.5) * 0.2);
      const trueMean = 10;

      const small = bootstrapCi(series, meanOf, { iterations: 50, meanBlockLen: 5, seed: 1 });
      const large = bootstrapCi(series, meanOf, { iterations: 2000, meanBlockLen: 5, seed: 1 });

      expect(large.high - large.low).toBeLessThan(small.high - small.low);
      expect(large.low).toBeLessThanOrEqual(trueMean);
      expect(large.high).toBeGreaterThanOrEqual(trueMean);
    });
  });

  describe('maxDrawdownPercentOfPnl', () => {
    it('computes max peak-to-trough drawdown as a percent of the peak', () => {
      // startEquity 1000 -> 1500 (peak) -> 500 (trough, dd = 1000/1500) -> 700
      const pnls = [500, -1000, 200];
      const result = maxDrawdownPercentOfPnl(pnls, 1000);
      expect(result).toBeCloseTo((1000 / 1500) * 100, 6);
    });

    it('returns 0 when equity never falls below a prior peak', () => {
      const pnls = [100, 100, 100];
      expect(maxDrawdownPercentOfPnl(pnls, 1000)).toBe(0);
    });

    it('handles a drawdown that starts immediately from startEquity', () => {
      // startEquity 1000 is itself the peak (no prior gain), drop to 800.
      const pnls = [-200, 50];
      const result = maxDrawdownPercentOfPnl(pnls, 1000);
      expect(result).toBeCloseTo((200 / 1000) * 100, 6);
    });

    it('throws RangeError for startEquity <= 0', () => {
      // Silently returning 0 would read as "no drawdown" to a validation
      // gate, rather than as invalid input.
      expect(() => maxDrawdownPercentOfPnl([100, -50], 0)).toThrow(RangeError);
      expect(() => maxDrawdownPercentOfPnl([100, -50], -1000)).toThrow(RangeError);
    });
  });
});

describe('groupedBlockBootstrapCi', () => {
  it('computes the point estimate over every observation, not over bucket means', () => {
    // Unequal bucket sizes: a bucket-mean average would give 1.5, the mean over
    // all four observations is 1.25.
    const groups = [[1, 1, 1], [2]];

    const result = groupedBlockBootstrapCi(groups, meanOf, {
      iterations: 50,
      meanBlockLen: 2,
      seed: 7,
    });

    expect(result.point).toBeCloseTo(1.25, 10);
    expect(result.buckets).toBe(2);
    expect(result.samples).toBe(50);
  });

  it('brackets the point estimate', () => {
    const groups = Array.from({ length: 200 }, (_, i) => [Math.sin(i), Math.cos(i)]);

    const result = groupedBlockBootstrapCi(groups, meanOf, {
      iterations: 200,
      meanBlockLen: 5,
      seed: 3,
    });

    expect(result.low).toBeLessThanOrEqual(result.point);
    expect(result.high).toBeGreaterThanOrEqual(result.point);
  });

  it('is deterministic for a given seed', () => {
    const groups = Array.from({ length: 100 }, (_, i) => [i % 7, (i * 3) % 5]);
    const opts = { iterations: 100, meanBlockLen: 4, seed: 42 };

    const first = groupedBlockBootstrapCi(groups, meanOf, opts);
    const second = groupedBlockBootstrapCi(groups, meanOf, opts);

    expect(second.low).toBe(first.low);
    expect(second.high).toBe(first.high);
  });

  it('keeps a bucket intact, so a whole cross-section moves together', () => {
    // Buckets are all-zero or all-hundred. Any resample must therefore be a
    // multiple of 100 / n; a resampler that mixed members across buckets could
    // produce intermediate values.
    const groups = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? [0, 0, 0, 0] : [100, 100, 100, 100]));

    const result = groupedBlockBootstrapCi(groups, meanOf, {
      iterations: 100,
      meanBlockLen: 3,
      seed: 11,
    });

    for (const bound of [result.low, result.high]) {
      const bucketsOfHundred = (bound / 100) * 40;
      expect(Math.abs(bucketsOfHundred - Math.round(bucketsOfHundred))).toBeLessThan(1e-9);
    }
  });
});
