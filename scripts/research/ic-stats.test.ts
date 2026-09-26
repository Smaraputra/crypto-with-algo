// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  barIcSeries,
  benjaminiHochberg,
  bootstrapCi,
  bootstrapCiOfMean,
  crossSectionalIcSeries,
  demeanAcrossSymbols,
  forwardReturns,
  hacTStatOfMean,
  icNonOverlapping,
  icWithHac,
  nonOverlappingIndices,
  pValueFromT,
  quantileSpread,
  quarterOf,
  rank,
  rollingByQuarter,
  signHitRate,
  spearman,
  standardizedRankProducts,
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

describe('forwardReturns execution lag', () => {
  const closes = [100, 110, 121, 133.1, 146.41];

  it('measures from the factor bar itself when the lag is 0', () => {
    // (110 - 100) / 100 = 0.1
    expect(forwardReturns(closes, 1)[0]).toBeCloseTo(0.1, 12);
    expect(forwardReturns(closes, 1, 0)).toEqual(forwardReturns(closes, 1));
  });

  it('measures from the next bar when the lag is 1', () => {
    // (121 - 110) / 110 = 0.1, entered one bar after the factor is read.
    expect(forwardReturns(closes, 1, 1)[0]).toBeCloseTo(0.1, 12);
    expect(forwardReturns(closes, 2, 1)[0]).toBeCloseTo((133.1 - 110) / 110, 12);
  });

  it('nulls the tail the lag pushes past the end', () => {
    const lag0 = forwardReturns(closes, 1, 0);
    const lag1 = forwardReturns(closes, 1, 1);
    expect(lag0[closes.length - 1]).toBeNull();
    expect(lag1[closes.length - 2]).toBeNull();
    expect(lag1[closes.length - 1]).toBeNull();
  });

  it('removes the shared price term that manufactures a bid-ask bounce IC', () => {
    // A pure random walk in "true" price, observed with independent noise on
    // every print. A factor built from the observed price at t shares that
    // print with a lag-0 return's denominator, so noise alone produces a
    // negative IC; at lag 1 the shared term is gone and it vanishes.
    let rng = 7;
    const next = () => {
      rng = (rng * 16807) % 2147483647;
      return rng / 2147483647;
    };

    const observed: number[] = [];
    let truePrice = 100;
    const noise: number[] = [];
    for (let i = 0; i < 4000; i++) {
      truePrice *= 1 + (next() - 0.5) * 0.002;
      const e = (next() - 0.5) * 0.004;
      noise.push(e);
      observed.push(truePrice * (1 + e));
    }

    // The factor is the noise itself: the part of the observed print that is
    // not the true price. It has no predictive content by construction.
    const lag0 = spearman(
      noise.slice(0, 3900),
      forwardReturns(observed, 1, 0).slice(0, 3900).map((v) => v ?? 0)
    );
    const lag1 = spearman(
      noise.slice(0, 3900),
      forwardReturns(observed, 1, 1).slice(0, 3900).map((v) => v ?? 0)
    );

    // Lag 0 shows a large spurious correlation; lag 1 is near zero.
    expect(Math.abs(lag0)).toBeGreaterThan(0.3);
    expect(Math.abs(lag1)).toBeLessThan(0.05);
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

  it('throws on a non-positive h instead of looping forever', () => {
    expect(() => nonOverlappingIndices(10, 0)).toThrow();
    expect(() => nonOverlappingIndices(10, -1)).toThrow();
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

describe('standardizedRankProducts', () => {
  it('mean equals spearman on the same overlapping pairs within 1e-9', () => {
    const h = 4;
    const closes: number[] = [];
    for (let i = 0; i < 60; i++) {
      closes.push(100 + i + Math.sin(i / 3) * 3);
    }
    const fwd = forwardReturns(closes, h);
    // Same NaN-injection pattern as the icWithHac test above, to exercise the same pairwise-drop path.
    const factor = closes.map((_, i) => (i % 7 === 0 ? NaN : Math.sin(i / 5)));

    const d = standardizedRankProducts(factor, fwd);
    const meanD = d.reduce((s, v) => s + v, 0) / d.length;

    const { ic, n } = icWithHac(factor, fwd, h);
    expect(d).toHaveLength(n);
    expect(meanD).toBeCloseTo(ic, 9);
  });

  it('returns an empty array when fewer than 3 overlapping pairs remain', () => {
    expect(standardizedRankProducts([1, NaN, NaN], [0.1, null, 0.2])).toEqual([]);
  });
});

describe('bootstrapCiOfMean', () => {
  const next = makeRng(777);
  const factor: number[] = [];
  const fwd: number[] = [];
  for (let i = 0; i < 200; i++) {
    const f = next() * 10 - 5;
    const noise = (next() - 0.5) * 2;
    factor.push(f);
    fwd.push(f * 0.5 + noise);
  }
  const d = standardizedRankProducts(factor, fwd);
  const trueIc = icWithHac(factor, fwd, 1).ic;

  it('point equals the mean of d, which equals the full-sample ic', () => {
    const { point } = bootstrapCiOfMean(d, { iterations: 10, meanBlockLen: 5, seed: 1 });
    expect(point).toBeCloseTo(trueIc, 9);
  });

  it('is deterministic for a given seed', () => {
    const opts = { iterations: 300, meanBlockLen: 5, seed: 123 };
    const a = bootstrapCiOfMean(d, opts);
    const b = bootstrapCiOfMean(d, opts);
    expect(a).toEqual(b);
  });

  it('the interval contains the full-sample ic for a synthetic linear relation', () => {
    const { low, high } = bootstrapCiOfMean(d, { iterations: 500, meanBlockLen: 5, seed: 123 });
    expect(low).toBeLessThanOrEqual(trueIc);
    expect(high).toBeGreaterThanOrEqual(trueIc);
  });

  it('the estimate stabilizes (varies less across seeds) with more iterations', () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const widthOf = (iterations: number, seed: number) => {
      const { low, high } = bootstrapCiOfMean(d, { iterations, meanBlockLen: 5, seed });
      return high - low;
    };
    const stddev = (values: number[]) => {
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
    };

    const fewIterations = seeds.map((seed) => widthOf(20, seed));
    const manyIterations = seeds.map((seed) => widthOf(2000, seed));

    // More iterations means less Monte Carlo noise in the percentile
    // estimate, so the width estimate itself varies less across otherwise
    // unrelated seeds (the interval's true width is fixed; only the
    // estimate of it narrows in its own variability with more iterations).
    expect(stddev(manyIterations)).toBeLessThan(stddev(fewIterations));
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

describe('pValueFromT', () => {
  it('is two-sided: |t| of 1.96 gives p 0.05 either sign', () => {
    expect(pValueFromT(1.96)).toBeCloseTo(0.05, 3);
    expect(pValueFromT(-1.96)).toBeCloseTo(0.05, 3);
  });

  it('is 1 at t 0, 0 at infinite t, NaN at NaN', () => {
    expect(pValueFromT(0)).toBeCloseTo(1, 12);
    expect(pValueFromT(Infinity)).toBe(0);
    expect(pValueFromT(-Infinity)).toBe(0);
    expect(pValueFromT(NaN)).toBeNaN();
  });
});

describe('benjaminiHochberg', () => {
  // Benjamini and Hochberg (1995), the worked example: 15 p-values, q 0.05
  // rejects exactly the four smallest (the fifth, 0.0201, exceeds 5/15 * 0.05).
  const BH_1995 = [
    0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.324, 0.4262, 0.5719,
    0.6528, 0.759, 1.0,
  ];

  it('reproduces the 1995 worked example: four rejections at q 0.05', () => {
    const rejected = benjaminiHochberg(BH_1995, 0.05);
    expect(rejected.slice(0, 4)).toEqual([true, true, true, true]);
    expect(rejected.slice(4).some(Boolean)).toBe(false);
  });

  it('returns results in input order, not sorted order', () => {
    // m 4: thresholds 0.0125k. Sorted 0.0001, 0.0095, 0.0201, 0.324: k 3 passes
    // (0.0201 <= 0.0375), k 4 fails, so the three small ones are rejected.
    expect(benjaminiHochberg([0.324, 0.0001, 0.0201, 0.0095], 0.05)).toEqual([false, true, true, true]);
  });

  it('rejects nothing when every p is 1 and everything when every p is 0', () => {
    expect(benjaminiHochberg([1, 1, 1], 0.1)).toEqual([false, false, false]);
    expect(benjaminiHochberg([0, 0, 0], 0.1)).toEqual([true, true, true]);
  });

  it('never rejects a non-finite p and excludes it from m', () => {
    // With m 2, 0.09 <= (2/2) * 0.1 passes. Counting the NaN as a third
    // hypothesis would make the k 2 threshold 0.0667 and fail it.
    expect(benjaminiHochberg([0.04, 0.09, NaN], 0.1)).toEqual([true, true, false]);
  });

  it('is monotone: every p below a rejected one is also rejected', () => {
    const ps = [0.5, 0.001, 0.02, 0.0005, 0.3, 0.049];
    const rejected = benjaminiHochberg(ps, 0.1);
    const maxRejected = Math.max(...ps.filter((_, i) => rejected[i]));
    ps.forEach((p, i) => {
      if (p <= maxRejected) expect(rejected[i]).toBe(true);
    });
  });

  it('throws on a q outside (0, 1) and returns [] for empty input', () => {
    expect(() => benjaminiHochberg([0.5], 0)).toThrow();
    expect(() => benjaminiHochberg([0.5], 1)).toThrow();
    expect(benjaminiHochberg([], 0.1)).toEqual([]);
  });
});

describe('demeanAcrossSymbols', () => {
  it('subtracts the equal-weight mean of the symbols present at each timestamp', () => {
    const timestamps = [[0, 1, 2], [0, 1, 2]];
    const fwd = [Float64Array.from([1, 2, NaN]), Float64Array.from([3, 4, 5])];
    const out = demeanAcrossSymbols(timestamps, fwd, 2);
    expect(Array.from(out[0])).toEqual([-1, -1, NaN]);
    expect(Array.from(out[1])).toEqual([1, 1, NaN]);
  });

  it('is NaN for every symbol at a bar narrower than minCrossSection, and handles gappy timestamps', () => {
    const timestamps = [[0, 1, 2], [0, 2]];
    const fwd = [Float64Array.from([1, 2, 3]), Float64Array.from([3, 5])];
    const out = demeanAcrossSymbols(timestamps, fwd, 2);
    expect(Array.from(out[0])).toEqual([-1, NaN, -1]);
    expect(Array.from(out[1])).toEqual([1, 1]);
  });
});

describe('crossSectionalIcSeries', () => {
  it('is one Spearman per bar, skipping bars narrower than minCrossSection', () => {
    const bars = [
      { factor: [1, 2, 3], fwd: [1, 2, 3] },
      { factor: [1, 2, 3], fwd: [3, 2, 1] },
      { factor: [1, 2], fwd: [1, 2] },
    ];
    expect(crossSectionalIcSeries(bars, 3)).toEqual([1, -1]);
  });

  it('drops a bar whose IC is undefined (constant returns)', () => {
    expect(crossSectionalIcSeries([{ factor: [1, 2, 3], fwd: [0, 0, 0] }], 3)).toEqual([]);
  });
});

describe('barIcSeries', () => {
  it('groups by timestamp across symbols and returns one Spearman per bar in time order', () => {
    const per = [
      { timestamps: [0, 1, 2], factor: [1, 1, 1], fwd: [1, 3, 1] },
      { timestamps: [0, 1, 2], factor: [2, 2, 2], fwd: [2, 2, 2] },
      { timestamps: [0, 1, 2], factor: [3, 3, 3], fwd: [3, 1, NaN] },
    ];
    const out = barIcSeries(per, 3);
    expect(out.t).toEqual([0, 1]);
    expect(out.ic[0]).toBeCloseTo(1, 12);
    expect(out.ic[1]).toBeCloseTo(-1, 12);
  });

  it('is empty when the factor is identical across symbols at every bar', () => {
    const per = [
      { timestamps: [0, 1], factor: [5, 6], fwd: [1, 2] },
      { timestamps: [0, 1], factor: [5, 6], fwd: [2, 1] },
      { timestamps: [0, 1], factor: [5, 6], fwd: [3, 3] },
    ];
    expect(barIcSeries(per, 3)).toEqual({ t: [], ic: [] });
  });
});
