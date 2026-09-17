// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  bootstrapCi,
  forwardReturns,
  hacTStatOfMean,
  icNonOverlapping,
  icWithHac,
  nonOverlappingIndices,
  quantileSpread,
  quarterOf,
  rank,
  rollingByQuarter,
  signHitRate,
  spearman,
  stationaryBlockBootstrapIndices,
} from './ic-stats';

// Deterministic LCG matching the pattern in src/lib/backtest/engine-parity.test.ts
function makeRng(seed: number): () => number {
  let state = seed;
  return function next(): number {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

describe('rank', () => {
  it('ranks a strictly increasing series 1..n', () => {
    expect(rank([10, 20, 30, 40])).toEqual([1, 2, 3, 4]);
  });

  it('averages ranks for ties (hand-computed)', () => {
    // sorted: 10(1), 20(2), 20(3), 30(4) -> tied 20s average to 2.5
    expect(rank([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });
});

describe('spearman', () => {
  it('is 1 for a monotonically increasing series', () => {
    expect(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1, 12);
  });

  it('is -1 for a monotonically decreasing series', () => {
    expect(spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])).toBeCloseTo(-1, 12);
  });

  it('matches a hand-computed value with ties', () => {
    // rank([10,20,20,30]) = [1, 2.5, 2.5, 4]; rank([1,2,3,4]) = [1,2,3,4]
    // pearson of those two rank vectors = 0.9486832980505138
    expect(spearman([10, 20, 20, 30], [1, 2, 3, 4])).toBeCloseTo(0.9486832980505138, 12);
  });

  it('drops pairs where either value is not finite', () => {
    const withNoise = spearman([1, 2, NaN, 4, 5], [10, 20, 999, 40, 50]);
    const clean = spearman([1, 2, 4, 5], [10, 20, 40, 50]);
    expect(withNoise).toBeCloseTo(clean, 12);
  });

  it('returns NaN when fewer than 3 finite pairs remain', () => {
    expect(spearman([1, NaN, 3, Infinity], [1, 2, 3, 4])).toBeNaN();
    expect(spearman([1, 2], [1, 2])).toBeNaN();
  });
});

describe('forwardReturns', () => {
  it('computes (c[i+h]-c[i])/c[i] and nulls the last h positions', () => {
    const closes = [100, 110, 121, 133.1];
    const result = forwardReturns(closes, 1);
    expect(result[0]).toBeCloseTo(0.1, 10);
    expect(result[1]).toBeCloseTo(0.1, 10);
    expect(result[2]).toBeCloseTo(0.1, 10);
    expect(result[3]).toBeNull();
  });

  it('nulls the last h positions for h > 1', () => {
    const closes = [100, 110, 121, 133.1];
    const result = forwardReturns(closes, 2);
    expect(result[0]).toBeCloseTo(0.21, 10);
    expect(result[1]).toBeCloseTo(0.21, 10);
    expect(result[2]).toBeNull();
    expect(result[3]).toBeNull();
  });
});

describe('nonOverlappingIndices', () => {
  it('returns offset, offset+h, ... below n', () => {
    expect(nonOverlappingIndices(10, 3, 0)).toEqual([0, 3, 6, 9]);
    expect(nonOverlappingIndices(10, 3, 1)).toEqual([1, 4, 7]);
  });

  it('returns an empty array when offset is already >= n', () => {
    expect(nonOverlappingIndices(5, 3, 5)).toEqual([]);
  });
});

describe('hacTStatOfMean', () => {
  it('equals the ordinary standard error of the mean at lag 0', () => {
    const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const n = series.length;
    const mean = series.reduce((s, v) => s + v, 0) / n;
    const variance = series.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
    const naiveSe = Math.sqrt(variance / n);

    const result = hacTStatOfMean(series, 0);
    expect(result.mean).toBeCloseTo(mean, 12);
    expect(result.se).toBeCloseTo(naiveSe, 12);
    expect(result.t).toBeCloseTo(mean / naiveSe, 12);
  });

  it('produces a larger se than the naive se for a positively autocorrelated AR(1) series', () => {
    // AR(1) with phi=0.8: e_t = phi*e_{t-1} + eps_t
    const next = makeRng(555);
    const series: number[] = [];
    let prev = 0;
    for (let i = 0; i < 300; i++) {
      const eps = next() - 0.5;
      const value = 0.8 * prev + eps;
      series.push(value);
      prev = value;
    }

    const n = series.length;
    const mean = series.reduce((s, v) => s + v, 0) / n;
    const variance = series.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
    const naiveSe = Math.sqrt(variance / n);

    const lag0 = hacTStatOfMean(series, 0);
    const lag10 = hacTStatOfMean(series, 10);

    expect(lag0.se).toBeCloseTo(naiveSe, 10);
    expect(lag10.se).toBeGreaterThan(naiveSe);
  });
});

describe('icWithHac', () => {
  it('ic equals spearman on the same overlapping pairs within 1e-9', () => {
    const h = 4;
    const closes: number[] = [];
    for (let i = 0; i < 60; i++) {
      closes.push(100 + i + Math.sin(i / 3) * 3);
    }
    const fwd = forwardReturns(closes, h);
    // Inject occasional non-finite factor values to exercise the dropped-pair path
    const factor = closes.map((_, i) => (i % 7 === 0 ? NaN : Math.sin(i / 5)));

    const { ic, n, t } = icWithHac(factor, fwd, h);

    const pairsF: number[] = [];
    const pairsR: number[] = [];
    for (let i = 0; i < factor.length; i++) {
      const f = factor[i];
      const r = fwd[i];
      if (Number.isFinite(f) && r !== null && Number.isFinite(r)) {
        pairsF.push(f);
        pairsR.push(r);
      }
    }
    const expectedIc = spearman(pairsF, pairsR);

    expect(n).toBe(pairsF.length);
    expect(ic).toBeCloseTo(expectedIc, 9);
    expect(Number.isFinite(t)).toBe(true);
  });

  it('returns NaN when fewer than 3 overlapping pairs remain', () => {
    const result = icWithHac([1, NaN, NaN], [0.1, null, 0.2], 2);
    expect(result.ic).toBeNaN();
    expect(result.t).toBeNaN();
  });
});

describe('icNonOverlapping', () => {
  it('uses only non-overlapping indices and matches spearman + the naive t formula', () => {
    const h = 3;
    const offset = 0;
    const idxs = nonOverlappingIndices(12, h, offset); // [0,3,6,9]
    const factor = [5, 1, 1, 3, 1, 1, 7, 1, 1, 2, 1, 1];
    const fwd = [0.5, 9, 9, 0.1, 9, 9, 0.9, 9, 9, 0.05, 9, 9];

    const result = icNonOverlapping(factor, fwd, h, offset);
    const expectedIc = spearman(
      idxs.map((i) => factor[i]),
      idxs.map((i) => fwd[i])
    );

    expect(result.n).toBe(4);
    expect(result.ic).toBeCloseTo(expectedIc, 12);

    if (Number.isFinite(result.ic) && Math.abs(result.ic) < 1) {
      const expectedT =
        result.ic * Math.sqrt((result.n - 2) / (1 - result.ic * result.ic));
      expect(result.t).toBeCloseTo(expectedT, 8);
    }
  });
});

describe('signHitRate', () => {
  it('computes the share of nonzero-factor pairs whose signs agree (hand-built)', () => {
    // factor=0 at index 3 is excluded from the denominator
    const factor = [1, -1, 2, 0, -3, 5];
    const fwd = [0.1, 0.2, -0.1, 0.5, -0.2, 0.05];
    // hits: idx0 (+/+), idx4 (-/-), idx5 (+/+) = 3 of 5 eligible
    expect(signHitRate(factor, fwd)).toBeCloseTo(0.6, 12);
  });
});

describe('quantileSpread', () => {
  it('computes mean forward return in the top/bottom quantile (hand-built)', () => {
    const factor = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const fwd = factor.map((f) => f * 0.01);

    const { top, bottom, spread } = quantileSpread(factor, fwd, 0.2);
    expect(bottom).toBeCloseTo(0.015, 12);
    expect(top).toBeCloseTo(0.095, 12);
    expect(spread).toBeCloseTo(0.08, 12);
  });
});

describe('stationaryBlockBootstrapIndices', () => {
  it('is deterministic for a given seed', () => {
    const a = stationaryBlockBootstrapIndices(50, 5, 42);
    const b = stationaryBlockBootstrapIndices(50, 5, 42);
    expect(a).toEqual(b);
  });

  it('returns n indices, all within [0, n)', () => {
    const indices = stationaryBlockBootstrapIndices(37, 4, 7);
    expect(indices).toHaveLength(37);
    for (const idx of indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(37);
    }
  });

  it('differs for different seeds (not a constant sequence)', () => {
    const a = stationaryBlockBootstrapIndices(50, 5, 1);
    const b = stationaryBlockBootstrapIndices(50, 5, 2);
    expect(a).not.toEqual(b);
  });
});

describe('bootstrapCi', () => {
  const next = makeRng(777);
  const factor: number[] = [];
  const fwd: number[] = [];
  for (let i = 0; i < 200; i++) {
    const f = next() * 10 - 5;
    const noise = (next() - 0.5) * 2;
    factor.push(f);
    fwd.push(f * 0.5 + noise);
  }
  const statistic = (f: number[], r: number[]) => spearman(f, r);

  it('is deterministic for a given seed', () => {
    const opts = { iterations: 300, meanBlockLen: 5, seed: 123 };
    const a = bootstrapCi(factor, fwd, statistic, opts);
    const b = bootstrapCi(factor, fwd, statistic, opts);
    expect(a).toEqual(b);
  });

  it('the interval contains the observed statistic for a synthetic linear relation', () => {
    const trueStat = statistic(factor, fwd);
    const { low, high } = bootstrapCi(factor, fwd, statistic, {
      iterations: 500,
      meanBlockLen: 5,
      seed: 123,
    });

    expect(low).toBeLessThanOrEqual(trueStat);
    expect(high).toBeGreaterThanOrEqual(trueStat);
  });
});

describe('quarterOf', () => {
  it('reports quarter boundaries in UTC', () => {
    expect(quarterOf(Date.UTC(2025, 0, 1))).toBe('2025Q1');
    expect(quarterOf(Date.UTC(2025, 2, 31, 23, 59, 59))).toBe('2025Q1');
    expect(quarterOf(Date.UTC(2025, 3, 1))).toBe('2025Q2');
    expect(quarterOf(Date.UTC(2025, 6, 15))).toBe('2025Q3');
    expect(quarterOf(Date.UTC(2025, 11, 31, 23, 59, 59))).toBe('2025Q4');
  });
});

describe('rollingByQuarter', () => {
  it('groups bars by quarter and computes per-quarter IC', () => {
    // Q1: 6 bars, perfectly aligned (ic=1); Q2: 6 bars, perfectly inverted (ic=-1)
    const q1Timestamps = Array.from({ length: 6 }, (_, i) => Date.UTC(2025, 0, 1 + i));
    const q2Timestamps = Array.from({ length: 6 }, (_, i) => Date.UTC(2025, 3, 1 + i));
    const timestamps = [...q1Timestamps, ...q2Timestamps];

    const factor = [1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6];
    const fwd = [10, 20, 30, 40, 50, 60, 60, 50, 40, 30, 20, 10];

    const h = 1;
    const result = rollingByQuarter(timestamps, factor, fwd, h);

    expect(result.map((r) => r.quarter)).toEqual(['2025Q1', '2025Q2']);
    expect(result[0].n).toBeGreaterThan(0);
    expect(result[1].n).toBeGreaterThan(0);
    expect(result[0].ic).toBeGreaterThan(0);
    expect(result[1].ic).toBeLessThan(0);
  });
});
