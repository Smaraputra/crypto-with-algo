import { describe, it, expect } from 'vitest';
import {
  expectedMaxSharpe,
  probabilisticSharpe,
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
