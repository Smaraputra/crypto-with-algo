import { describe, expect, it } from 'vitest';
import { rankWeightedCorrelation } from '@/lib/stats/rank-ic';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import {
  eValue,
  eValue0,
  initialEState,
  isValidated,
  kellyLambda,
  LAB_CAP_NUMERATOR,
  LAB_THRESHOLD,
  LAB_VARIANCE_EPS,
  LAB_WARMUP_BARS,
  LabBar,
  runEProcess,
  stepEProcess,
} from './e-process';

describe('e-process', () => {
  describe('constants and initial state', () => {
    it('sets expected threshold', () => {
      expect(LAB_THRESHOLD).toBe(800);
    });

    it('creates initial state with zero wealth and no crossing', () => {
      const state = initialEState();
      expect(state.logE).toBe(0);
      expect(state.logE0).toBe(0);
      expect(state.n).toBe(0);
      expect(state.sumD).toBe(0);
      expect(state.sumD2).toBe(0);
      expect(state.sumX).toBe(0);
      expect(state.sumX2).toBe(0);
      expect(state.crossedAt).toBeNull();
      expect(isValidated(state)).toBe(false);
      expect(eValue(state)).toBe(1);
      expect(eValue0(state)).toBe(1);
    });
  });

  describe('kellyLambda', () => {
    it('returns zero during warm-up period', () => {
      expect(kellyLambda(29, 10, 10, 0.5)).toBe(0);
      expect(kellyLambda(LAB_WARMUP_BARS - 1, 100, 100, 0.5)).toBe(0);
    });

    it('computes capped bet size when past variance is known', () => {
      // n = 40, sum = 4, sum2 = 1
      // m = 4 / 40 = 0.1
      // v = 1 / 40 - 0.01 = 0.015
      // raw = 0.1 / (0.015 + 1e-6) = 0.1 / 0.015001 ~= 6.666
      // capped at 0.5
      expect(kellyLambda(40, 4, 1, 0.5)).toBe(0.5);
    });

    it('returns zero for a negative mean edge', () => {
      expect(kellyLambda(40, -4, 1, 0.5)).toBe(0);
    });

    it('returns zero on non-finite values', () => {
      expect(kellyLambda(40, NaN, 1, 0.5)).toBe(0);
      expect(kellyLambda(40, 1, NaN, 0.5)).toBe(0);
      expect(kellyLambda(40, 1, 1, NaN)).toBe(0);
    });
  });

  describe('stepEProcess', () => {
    it('ignores degenerate bars without mutating state', () => {
      const start = initialEState();
      const degenerateBars: LabBar[] = [
        { barTime: 1, x: null, b: 0 },
        { barTime: 2, x: NaN, b: 0 },
        { barTime: 3, x: 1.5, b: 0 },
        { barTime: 4, x: -1.5, b: 0 },
        { barTime: 5, x: 0.1, b: null },
        { barTime: 6, x: 0.1, b: -0.01 },
        { barTime: 7, x: 0.1, b: NaN },
      ];

      for (const bar of degenerateBars) {
        const res = stepEProcess(start, bar);
        expect(res.bet).toBe(false);
        expect(res.lambda).toBe(0);
        expect(res.lambda0).toBe(0);
        expect(res.state).toEqual(start);
        expect(res.state).not.toBe(start);
      }
    });

    it('keeps logE and logE0 at zero during warm-up bars while accumulating sums', () => {
      let state = initialEState();
      const barsCount = 30;
      const xVal = 0.1;
      const bVal = 0.02;
      const dVal = xVal - bVal;

      for (let i = 0; i < barsCount; i++) {
        const res = stepEProcess(state, { barTime: i * 1000, x: xVal, b: bVal });
        expect(res.bet).toBe(true);
        expect(res.lambda).toBe(0);
        expect(res.lambda0).toBe(0);
        state = res.state;
      }

      expect(state.n).toBe(30);
      expect(state.logE).toBe(0);
      expect(state.logE0).toBe(0);
      expect(state.sumD).toBeCloseTo(30 * dVal, 12);
      expect(state.sumD2).toBeCloseTo(30 * dVal * dVal, 12);
      expect(state.sumX).toBeCloseTo(30 * xVal, 12);
      expect(state.sumX2).toBeCloseTo(30 * xVal * xVal, 12);
      expect(state.crossedAt).toBeNull();
    });

    it('matches exact hand-computed values on first live betting step', () => {
      const startState = {
        logE: 0,
        logE0: 0,
        n: 30,
        sumD: 3,
        sumD2: 0.6,
        sumX: 4.5,
        sumX2: 1.2,
        crossedAt: null,
      };
      const bar: LabBar = { barTime: 5000, x: 0.2, b: 0.05 };
      const res = stepEProcess(startState, bar);

      const d = 0.2 - 0.05; // 0.15
      const cap = 0.5 / 1.05;
      // m = 3 / 30 = 0.1, v = 0.6 / 30 - 0.01 = 0.01
      // raw = 0.1 / (0.01 + 1e-6) = 0.1 / 0.010001 ~= 9.999 > cap
      expect(res.bet).toBe(true);
      expect(res.lambda).toBeCloseTo(cap, 12);
      expect(res.state.logE).toBeCloseTo(Math.log1p(cap * d), 12);

      // lambda0 hand check
      const mX = 4.5 / 30; // 0.15
      const vX = 1.2 / 30 - mX * mX; // 0.04 - 0.0225 = 0.0175
      const raw0 = mX / (vX + LAB_VARIANCE_EPS);
      const expectedLambda0 = Math.min(Math.max(raw0, 0), LAB_CAP_NUMERATOR);
      expect(res.lambda0).toBeCloseTo(expectedLambda0, 12);
      expect(res.state.logE0).toBeCloseTo(Math.log1p(expectedLambda0 * 0.2), 12);
    });

    it('keeps crossedAt sticky once crossed even if logE falls', () => {
      const thresholdLog = Math.log(LAB_THRESHOLD);
      const startState = {
        logE: thresholdLog - 0.01,
        logE0: 0,
        n: 40,
        sumD: 4,
        sumD2: 1,
        sumX: 4,
        sumX2: 1,
        crossedAt: null,
      };

      // Bar that pushes logE over the threshold at barTime 1000
      const crossBar: LabBar = { barTime: 1000, x: 0.5, b: 0.01 };
      const step1 = stepEProcess(startState, crossBar);
      expect(step1.state.logE).toBeGreaterThanOrEqual(thresholdLog);
      expect(step1.state.crossedAt).toBe(1000);
      expect(isValidated(step1.state)).toBe(true);

      // Subsequent losing bar that causes logE to decline
      const dropBar: LabBar = { barTime: 2000, x: -0.8, b: 0.01 };
      const step2 = stepEProcess(step1.state, dropBar);
      expect(step2.state.logE).toBeLessThan(step1.state.logE);
      expect(step2.state.crossedAt).toBe(1000);
      expect(isValidated(step2.state)).toBe(true);
    });

    it('preserves predictability across runs', () => {
      const rand = createSeededRandom(98765);
      // Construct bars with positive mean edge and sufficient variance so raw is in (0, cap)
      const bars1: LabBar[] = Array.from({ length: 200 }, (_, i) => ({
        barTime: i * 60,
        x: 0.02 + (rand() - 0.5) * 0.8,
        b: 0.005,
      }));

      const res1 = runEProcess(bars1);

      // Create a second series differing only at bar 120
      const bars2 = bars1.map((bar, i) =>
        i === 120 ? { ...bar, x: (bar.x ?? 0) > 0 ? -0.3 : 0.3 } : { ...bar }
      );
      const res2 = runEProcess(bars2);

      // Every lambda and lambda0 for bars 0..120 must be identical
      for (let i = 0; i <= 120; i++) {
        expect(res2[i].lambda).toBe(res1[i].lambda);
        expect(res2[i].lambda0).toBe(res1[i].lambda0);
      }

      // Bar 121 lambda uses bar 120 summary statistics, so it must differ
      expect(res2[121].lambda).not.toBe(res1[121].lambda);
    });

    it('maintains bounded factor 1 + lambda * (x - b) >= 0.5 for all betting bars', () => {
      const rand = createSeededRandom(12345);
      let state = initialEState();

      for (let i = 0; i < 2000; i++) {
        // Include extreme x values periodically
        let x = (rand() - 0.5) * 2;
        if (i % 50 === 0) x = -1;
        if (i % 50 === 1) x = 1;

        const b = rand() * 0.05;
        const bar: LabBar = { barTime: i * 100, x, b };
        const step = stepEProcess(state, bar);

        if (step.bet) {
          const factor = 1 + step.lambda * (x - b);
          const factor0 = 1 + step.lambda0 * x;
          expect(factor).toBeGreaterThanOrEqual(0.5 - 1e-12);
          expect(factor0).toBeGreaterThanOrEqual(0.5 - 1e-12);
        }
        state = step.state;
      }
    });
  });

  describe('calibration', () => {
    // Helper to evaluate exact Student t quantile for df = 4
    function studentT4Quantile(p: number): number {
      const a = 4 * p * (1 - p);
      const sqrtA = Math.sqrt(a);
      const theta = Math.acos(sqrtA) / 3;
      const term = Math.cos(theta) / sqrtA - 1;
      return Math.sign(p - 0.5) * 2 * Math.sqrt(Math.max(0, term));
    }

    function createStandardNormal(rand: () => number): () => number {
      return function sampleNormal(): number {
        let u1 = rand();
        while (u1 <= 0 || u1 >= 1) {
          u1 = rand();
        }
        const u2 = rand();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      };
    }

    function createScaledT4(rand: () => number): () => number {
      return function sampleT4(): number {
        let p = rand();
        while (p <= 0 || p >= 1) {
          p = rand();
        }
        return studentT4Quantile(p) / Math.SQRT2;
      };
    }

    function sampleBar(
      rho: number,
      sampleNormal: () => number,
      sampleT4: () => number
    ): number {
      const scores = new Array<number>(10);
      const returns = new Array<number>(10);
      const sqrt1MinusRho2 = Math.sqrt(Math.max(0, 1 - rho * rho));
      for (let i = 0; i < 10; i++) {
        const s = sampleNormal();
        const e = sampleT4();
        scores[i] = s;
        returns[i] = rho * s + sqrt1MinusRho2 * e;
      }
      return rankWeightedCorrelation(scores, returns);
    }

    it('verifies exact Student t4 quantiles', () => {
      const q975 = studentT4Quantile(0.975);
      const q90 = studentT4Quantile(0.9);
      expect(Math.abs(q975 - 2.776445)).toBeLessThanOrEqual(1e-5);
      expect(Math.abs(q90 - 1.533206)).toBeLessThanOrEqual(1e-5);
    });

    it(
      'calibrates null with b = 0 over 300 runs of 2190 bars',
      () => {
        const rand = createSeededRandom(42);
        const sampleNormal = createStandardNormal(rand);
        const sampleT4 = createScaledT4(rand);

        let crossings = 0;
        const totalRuns = 300;
        const barsPerRun = 2190;

        for (let run = 0; run < totalRuns; run++) {
          let state = initialEState();
          for (let t = 0; t < barsPerRun; t++) {
            const x = sampleBar(0, sampleNormal, sampleT4);
            const res = stepEProcess(state, { barTime: t, x, b: 0 });
            state = res.state;
            if (state.crossedAt !== null) {
              crossings++;
              break;
            }
          }
        }

        console.log(`[calibration] null b=0 crossings: ${crossings} / ${totalRuns}`);
        expect(crossings).toBeLessThanOrEqual(2);
      },
      120_000
    );

    it(
      'calibrates null with hurdle b = 0.02 over 300 runs of 2190 bars',
      () => {
        const rand = createSeededRandom(1337);
        const sampleNormal = createStandardNormal(rand);
        const sampleT4 = createScaledT4(rand);

        let crossings = 0;
        const totalRuns = 300;
        const barsPerRun = 2190;
        const hurdleCost = 0.02;

        for (let run = 0; run < totalRuns; run++) {
          let state = initialEState();
          for (let t = 0; t < barsPerRun; t++) {
            const x = sampleBar(0, sampleNormal, sampleT4);
            const res = stepEProcess(state, { barTime: t, x, b: hurdleCost });
            state = res.state;
            if (state.crossedAt !== null) {
              crossings++;
              break;
            }
          }
        }

        console.log(`[calibration] null b=0.02 crossings: ${crossings} / ${totalRuns}`);
        expect(crossings).toBeLessThanOrEqual(2);
      },
      120_000
    );

    it(
      'calibrates planted edge rho = 0.08 with b = 0.01 over 200 runs of 2190 bars',
      () => {
        const rand = createSeededRandom(20261018);
        const sampleNormal = createStandardNormal(rand);
        const sampleT4 = createScaledT4(rand);

        const totalRuns = 200;
        const barsPerRun = 2190;
        const hurdleCost = 0.01;
        const crossingIndices: number[] = [];

        for (let run = 0; run < totalRuns; run++) {
          let state = initialEState();
          for (let t = 0; t < barsPerRun; t++) {
            const x = sampleBar(0.08, sampleNormal, sampleT4);
            const res = stepEProcess(state, { barTime: t, x, b: hurdleCost });
            state = res.state;
            if (state.crossedAt !== null) {
              crossingIndices.push(t);
              break;
            }
          }
        }

        crossingIndices.sort((a, b) => a - b);
        const nCrossings = crossingIndices.length;
        const mid = Math.floor(nCrossings / 2);
        const median =
          nCrossings % 2 === 1
            ? crossingIndices[mid]
            : (crossingIndices[mid - 1] + crossingIndices[mid]) / 2;

        console.log(
          `[calibration] planted edge crossings: ${nCrossings} / ${totalRuns}, median bar: ${median}`
        );

        expect(nCrossings).toBeGreaterThanOrEqual(196);
        expect(median).toBeGreaterThanOrEqual(240);
        expect(median).toBeLessThanOrEqual(420);
      },
      120_000
    );
  });
});
