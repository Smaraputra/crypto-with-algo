import { describe, it, expect } from 'vitest';
import { createSeededRandom } from './seeded-random';
import {
  rank,
  pearson,
  centredRanks,
  populationSd,
  bookWeights,
  kN,
  kNNoTies,
  rankWeightedCorrelation,
  bookReturn,
} from './rank-ic';

describe('rank-ic', () => {
  describe('rank', () => {
    it('computes ranks and resolves ties with group mean', () => {
      expect(rank([10, 30, 20])).toEqual([1, 3, 2]);
      expect(rank([5, 5, 1])).toEqual([2.5, 2.5, 1]);
    });
  });

  describe('pearson', () => {
    it('computes correlation and returns NaN when variance is zero', () => {
      expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
      expect(pearson([1, 1, 1], [1, 2, 3])).toBeNaN();
      expect(pearson([1, 2, 3], [2, 2, 2])).toBeNaN();
    });
  });

  describe('centredRanks', () => {
    it('centres ranks around (n + 1) / 2', () => {
      expect(centredRanks([10, 30, 20])).toEqual([-1, 1, 0]);
    });

    it('sums to 0 within 1e-12 for random values', () => {
      const random = createSeededRandom(7);
      const values = Array.from({ length: 10 }, () => random());
      const centred = centredRanks(values);
      const sum = centred.reduce((s, v) => s + v, 0);
      expect(Math.abs(sum)).toBeLessThan(1e-12);
    });

    it('sums to 0 with ties', () => {
      const tiedCentred = centredRanks([1, 1, 2, 3]);
      const sum = tiedCentred.reduce((s, v) => s + v, 0);
      expect(sum).toBe(0);
    });
  });

  describe('populationSd', () => {
    it('computes population standard deviation', () => {
      expect(populationSd([1, 2, 3, 4])).toBeCloseTo(Math.sqrt(1.25), 12);
    });

    it('throws on empty array', () => {
      expect(() => populationSd([])).toThrow('populationSd needs at least one value');
    });
  });

  describe('bookWeights', () => {
    it('computes dollar-neutral, gross-1 weights', () => {
      expect(bookWeights([1, 2, 3, 4])).toEqual([-0.375, -0.125, 0.125, 0.375]);
    });

    it('returns all zeros when all scores are tied', () => {
      expect(bookWeights([2, 2, 2])).toEqual([0, 0, 0]);
    });
  });

  describe('kNNoTies', () => {
    it('evaluates closed form correctly', () => {
      expect(kNNoTies(10)).toBeCloseTo(1.1489, 4);
      expect(kNNoTies(2)).toBe(1);
    });

    it('throws for n < 2 or non-integer n', () => {
      expect(() => kNNoTies(1)).toThrow();
      expect(() => kNNoTies(2.5)).toThrow();
    });
  });

  describe('kN', () => {
    it('equals kNNoTies for distinct scores within 1e-12', () => {
      expect(kN([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeCloseTo(kNNoTies(10), 12);

      const random = createSeededRandom(7);
      const randomScores = Array.from({ length: 10 }, () => random());
      expect(kN(randomScores)).toBeCloseTo(kNNoTies(10), 12);
    });

    it('returns NaN when all scores are tied', () => {
      expect(kN([5, 5, 5])).toBeNaN();
    });
  });

  describe('rankWeightedCorrelation', () => {
    it('is 1 for perfectly monotone and -1 for reversed returns', () => {
      const scores = [1, 2, 3, 4, 5];
      expect(rankWeightedCorrelation(scores, [0.01, 0.02, 0.03, 0.04, 0.05])).toBeCloseTo(1, 10);
      expect(rankWeightedCorrelation(scores, [0.05, 0.04, 0.03, 0.02, 0.01])).toBeCloseTo(-1, 10);
    });

    it('is strictly below 1 for non-linear monotone returns', () => {
      const scores = [1, 2, 3, 4, 5];
      const r = rankWeightedCorrelation(scores, [0.001, 0.002, 0.003, 0.004, 0.5]);
      expect(r).toBeLessThan(1);
      expect(r).toBeGreaterThan(0);
    });

    it('returns NaN for constant returns, all-tied scores, or non-finite input', () => {
      const scores = [1, 2, 3, 4, 5];
      expect(rankWeightedCorrelation(scores, [0.01, 0.01, 0.01, 0.01, 0.01])).toBeNaN();
      expect(rankWeightedCorrelation([2, 2, 2, 2, 2], [0.01, 0.02, 0.03, 0.04, 0.05])).toBeNaN();
      expect(rankWeightedCorrelation([1, NaN, 3, 4, 5], [0.01, 0.02, 0.03, 0.04, 0.05])).toBeNaN();
      expect(rankWeightedCorrelation([1, 2, 3, 4, 5], [0.01, Infinity, 0.03, 0.04, 0.05])).toBeNaN();
      expect(rankWeightedCorrelation([1], [0.01])).toBeNaN();
    });

    it('throws when scores and returns lengths differ', () => {
      expect(() => rankWeightedCorrelation([1, 2], [0.01])).toThrow(
        'scores and returns must have the same length',
      );
    });
  });

  describe('bookReturn', () => {
    it('throws when scores and returns lengths differ', () => {
      expect(() => bookReturn([1, 2], [0.01])).toThrow(
        'scores and returns must have the same length',
      );
    });
  });

  describe('identity: bookReturn === kN * populationSd * rankWeightedCorrelation', () => {
    it('holds within 1e-12 across 200 seeded random bars including tied bars', () => {
      const random = createSeededRandom(42);
      for (let bar = 0; bar < 200; bar++) {
        let scores = Array.from({ length: 10 }, () => random());
        if (bar < 20) {
          scores = scores.map((s) => Math.round(s * 10) / 10);
        }
        const returns = Array.from({ length: 10 }, () => (random() - 0.5) * 0.02);
        const actualReturn = bookReturn(scores, returns);
        const expectedReturn =
          kN(scores) * populationSd(returns) * rankWeightedCorrelation(scores, returns);

        const diff = Math.abs(actualReturn - expectedReturn);
        expect(diff).toBeLessThan(1e-12);
      }
    });
  });
});
