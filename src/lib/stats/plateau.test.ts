import { describe, it, expect } from 'vitest';
import { parameterPlateauScore } from './plateau';

describe('parameterPlateauScore', () => {
  it('is 1.0 when every neighbor equals the best metric', () => {
    // radius 1.0: every result's normalized distance is at most 1 by
    // construction (it cannot exceed the dimension's own range), so all
    // three non-best results count as neighbors.
    const best = { fast: 10, slow: 20 };
    const results = [
      { params: { fast: 10, slow: 20 }, metric: 2.0 },
      { params: { fast: 11, slow: 20 }, metric: 2.0 },
      { params: { fast: 9, slow: 20 }, metric: 2.0 },
      { params: { fast: 10, slow: 21 }, metric: 2.0 },
    ];
    const result = parameterPlateauScore(results, best, 1.0);
    expect(result.bestMetric).toBe(2.0);
    expect(result.neighbors).toBe(3);
    expect(result.score).toBeCloseTo(1.0, 10);
  });

  it('is below 1 when neighbors underperform the best', () => {
    const best = { fast: 10, slow: 20 };
    const results = [
      { params: { fast: 10, slow: 20 }, metric: 2.0 },
      { params: { fast: 11, slow: 20 }, metric: 1.0 },
      { params: { fast: 9, slow: 20 }, metric: 1.5 },
    ];
    const result = parameterPlateauScore(results, best, 0.5);
    expect(result.neighbors).toBe(2);
    expect(result.score).toBeLessThan(1);
    expect(result.score).toBeCloseTo((1.0 + 1.5) / 2 / 2.0, 10);
  });

  it('respects the neighbor radius', () => {
    // fast ranges 0..20 (range 20), slow fixed at 20 (range 0, contributes nothing).
    const best = { fast: 10, slow: 20 };
    const results = [
      { params: { fast: 10, slow: 20 }, metric: 2.0 }, // best itself
      { params: { fast: 11, slow: 20 }, metric: 1.9 }, // |1|/20 = 0.05
      { params: { fast: 0, slow: 20 }, metric: 1.0 }, // |10|/20 = 0.5
      { params: { fast: 20, slow: 20 }, metric: 0.5 }, // |10|/20 = 0.5
    ];
    const tight = parameterPlateauScore(results, best, 0.1);
    expect(tight.neighbors).toBe(1);

    const wide = parameterPlateauScore(results, best, 0.5);
    expect(wide.neighbors).toBe(3);
  });

  it('is NaN when there are no neighbors within radius', () => {
    const best = { fast: 10, slow: 20 };
    const results = [
      { params: { fast: 10, slow: 20 }, metric: 2.0 },
      { params: { fast: 0, slow: 20 }, metric: 1.0 },
    ];
    const result = parameterPlateauScore(results, best, 0.01);
    expect(result.neighbors).toBe(0);
    expect(Number.isNaN(result.score)).toBe(true);
  });

  it('is NaN when bestMetric is 0 or negative', () => {
    const best = { fast: 10, slow: 20 };
    const results = [
      { params: { fast: 10, slow: 20 }, metric: 0 },
      { params: { fast: 11, slow: 20 }, metric: 0.5 },
    ];
    // radius 1.0 so the single other candidate is guaranteed to be a neighbor
    // (its normalized distance is exactly 1, the whole range) and the NaN
    // here is isolated to bestMetric not being > 0, not to a lack of neighbors.
    const result = parameterPlateauScore(results, best, 1.0);
    expect(result.neighbors).toBe(1);
    expect(Number.isNaN(result.score)).toBe(true);

    const negativeBest = { fast: 10, slow: 20 };
    const negativeResults = [
      { params: { fast: 10, slow: 20 }, metric: -1 },
      { params: { fast: 11, slow: 20 }, metric: -0.5 },
    ];
    const negativeResult = parameterPlateauScore(negativeResults, negativeBest, 1.0);
    expect(negativeResult.neighbors).toBe(1);
    expect(Number.isNaN(negativeResult.score)).toBe(true);
  });

  it('a dimension with zero range across results contributes zero distance', () => {
    const best = { fast: 10, slow: 20 };
    const results = [
      { params: { fast: 10, slow: 20 }, metric: 2.0 },
      // slow is constant at 20 across all results (zero range), so only fast matters.
      { params: { fast: 12, slow: 20 }, metric: 1.8 },
    ];
    const result = parameterPlateauScore(results, best, 1);
    expect(result.neighbors).toBe(1);
  });

  it('disqualifies a row missing a dimension key instead of treating it as close', () => {
    const best = { fast: 10, slow: 20 };
    const results = [
      { params: { fast: 10, slow: 20 }, metric: 2.0 },
      { params: { fast: 11, slow: 20 }, metric: 1.9 }, // a genuine, close neighbor
      // Missing "slow" entirely: params[slow] is undefined, so the naive
      // Math.abs(undefined - best.slow) / range is NaN, and a NaN compared
      // with > silently fails, which previously let this row through as a
      // "neighbor" despite being 979 units away on "fast".
      { params: { fast: 989 } as unknown as Record<string, number>, metric: 100 },
    ];
    // Radius wide enough that the malformed row's "fast" distance alone
    // (|989-10|/979 ~= 1.0) would pass if its missing "slow" were ignored.
    const result = parameterPlateauScore(results, best, 1.0);
    expect(result.neighbors).toBe(1);
    expect(result.score).toBeCloseTo(1.9 / 2.0, 10);
  });

  it('returns NaN, not a misleading score, when best matches no entry in results', () => {
    // best is not present in results at all, so bestMetric falls back to 0
    // even though several rows land within the radius and neighbors > 0.
    const best = { fast: 15, slow: 20 };
    const results = [
      { params: { fast: 10, slow: 20 }, metric: 2.0 },
      { params: { fast: 20, slow: 20 }, metric: 1.5 },
    ];
    const result = parameterPlateauScore(results, best, 0.5);
    expect(result.bestMetric).toBe(0);
    expect(result.neighbors).toBeGreaterThan(0);
    expect(Number.isNaN(result.score)).toBe(true);
  });
});
