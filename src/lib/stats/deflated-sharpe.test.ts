import { describe, it, expect } from 'vitest';
import {
  expectedMaxSharpe,
  probabilisticSharpe,
  psrRadicand,
  deflatedSharpe,
  perPeriodSharpe,
} from './deflated-sharpe';

describe('deflated-sharpe', () => {
  describe('expectedMaxSharpe', () => {
    it('is 0 for one trial', () => {
      expect(expectedMaxSharpe(1, 0.04)).toBe(0);
    });

    it('increases with the number of trials', () => {
      const two = expectedMaxSharpe(2, 0.04);
      const ten = expectedMaxSharpe(10, 0.04);
      const hundred = expectedMaxSharpe(100, 0.04);
      expect(two).toBeGreaterThan(0);
      expect(ten).toBeGreaterThan(two);
      expect(hundred).toBeGreaterThan(ten);
    });

    it('matches reference values from the Bailey and Lopez de Prado formula', () => {
      // Independently verified against the formula: sqrt(variance) *
      // ((1-gamma) * Phi^-1(1 - 1/N) + gamma * Phi^-1(1 - 1/(N*e))).
      expect(expectedMaxSharpe(10, 0.04)).toBeCloseTo(0.3149196602689943, 12);
      expect(expectedMaxSharpe(100, 0.04)).toBeCloseTo(0.5061205786402285, 12);
    });

    it('throws RangeError for a negative variance', () => {
      expect(() => expectedMaxSharpe(10, -0.01)).toThrow(RangeError);
    });
  });

  describe('probabilisticSharpe', () => {
    it('is 0.5 when observed equals benchmark', () => {
      expect(probabilisticSharpe(0.1, 0.1, 250, 0, 3)).toBeCloseTo(0.5, 10);
    });

    it('increases with nObservations for a positive gap', () => {
      const small = probabilisticSharpe(0.2, 0.05, 60, 0, 3);
      const large = probabilisticSharpe(0.2, 0.05, 600, 0, 3);
      expect(large).toBeGreaterThan(small);
    });

    it('is within 1e-9 of 1 for a large nObservations and a clear positive gap', () => {
      // Regression coverage: this pushed the old series-based normalCdf into
      // catastrophic cancellation territory and returned -57355.75 instead of ~1.
      const result = probabilisticSharpe(0.2, 0.05, 5000, 0, 3);
      expect(Math.abs(result - 1)).toBeLessThan(1e-9);
    });

    it('never leaves [0, 1] over a grid of large nObservations', () => {
      for (const n of [100, 500, 1000, 2500, 5000, 10000, 50000]) {
        const result = probabilisticSharpe(0.2, 0.05, n, 0, 3);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }
    });

    it('matches a hand-computed value with nonzero skewness', () => {
      // observedSharpe=0.15, benchmarkSharpe=0.05, nObservations=100,
      // skewness=-0.5, kurtosis=4.
      // radicand = 1 - (-0.5 * 0.15) + (4-1)/4 * 0.15^2 = 1.091875
      // numerator = (0.15 - 0.05) * sqrt(99) = 0.99498743710662...
      // denominator = sqrt(1.091875) = 1.04492822720032...
      // x = numerator / denominator = 0.95220648768624...
      // result = normalCdf(x)
      const result = probabilisticSharpe(0.15, 0.05, 100, -0.5, 4);
      expect(result).toBeCloseTo(0.8295038642956399, 10);
    });

    it('returns NaN when psrRadicand is non-positive (moments outside the domain)', () => {
      // psrRadicand(0.3, 6, 10) = 1 - 6*0.3 + (10-1)/4*0.3^2 = -0.5975.
      expect(Number.isNaN(probabilisticSharpe(0.3, 0.05, 250, 6, 10))).toBe(true);
    });
  });

  describe('psrRadicand', () => {
    it('matches the formula 1 - skewness*SR + (kurtosis-1)/4*SR^2', () => {
      expect(psrRadicand(0.3, 6, 10)).toBeCloseTo(-0.5975, 10);
      expect(psrRadicand(0.1, 0, 3)).toBeCloseTo(1 + ((3 - 1) / 4) * 0.01, 10);
    });

    it('is positive for typical, non-extreme moments', () => {
      expect(psrRadicand(0.15, -0.5, 4)).toBeGreaterThan(0);
    });
  });

  describe('deflatedSharpe', () => {
    it('probability decreases as numTrials grows for a fixed observed Sharpe', () => {
      const base = {
        observedSharpe: 0.15,
        varianceOfTrialSharpes: 0.01,
        nObservations: 250,
        skewness: 0,
        kurtosis: 3,
      };
      const few = deflatedSharpe({ ...base, numTrials: 5 });
      const many = deflatedSharpe({ ...base, numTrials: 500 });
      expect(many.benchmarkSharpe).toBeGreaterThan(few.benchmarkSharpe);
      expect(many.probability).toBeLessThan(few.probability);
    });
  });

  describe('perPeriodSharpe', () => {
    it('matches a hand-computed value', () => {
      const returns = [1, 2, 3, 4, 5];
      // mean = 3, sample stdev (n-1) = sqrt(10/4) = sqrt(2.5)
      const expected = 3 / Math.sqrt(2.5);
      expect(perPeriodSharpe(returns)).toBeCloseTo(expected, 10);
    });

    it('is 0 when fewer than 2 observations', () => {
      expect(perPeriodSharpe([])).toBe(0);
      expect(perPeriodSharpe([5])).toBe(0);
    });

    it('is 0 when standard deviation is 0', () => {
      expect(perPeriodSharpe([2, 2, 2])).toBe(0);
    });
  });
});
