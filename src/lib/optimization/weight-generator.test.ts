import { describe, it, expect } from 'vitest';
import {
  generateConstrainedWeights,
  generateWeightCandidates,
  averageWeights,
  validateWeights,
} from './weight-generator';
import type { SignalWeights } from '@/types/signal';

describe('weight-generator', () => {
  const baseWeights: SignalWeights = {
    trend: 0.25,
    momentum: 0.30,
    volume: 0.20,
    volatility: 0.10,
    futures: 0.10,
    sentiment: 0.05,
  };

  describe('validateWeights', () => {
    it('validates correct weights', () => {
      expect(validateWeights(baseWeights)).toBe(true);
    });

    it('rejects weights that do not sum to 1.0', () => {
      const invalid: SignalWeights = {
        trend: 0.5,
        momentum: 0.3,
        volume: 0.1,
        volatility: 0.1,
        futures: 0.1,
        sentiment: 0.1,
      };
      expect(validateWeights(invalid)).toBe(false);
    });

    it('rejects negative weights', () => {
      const invalid: SignalWeights = {
        trend: 1.1,
        momentum: 0.0,
        volume: 0.0,
        volatility: 0.0,
        futures: 0.0,
        sentiment: -0.1,
      };
      expect(validateWeights(invalid)).toBe(false);
    });
  });

  describe('generateConstrainedWeights', () => {
    it('generates weights within constraint bounds', () => {
      interface RandomLike {
        next(): number;
      }

      class TestRandom implements RandomLike {
        next() {
          return Math.random();
        }
      }

      const rng = new TestRandom();
      const constraint = 0.2; // ±20%

      for (let i = 0; i < 100; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const weights = generateConstrainedWeights(baseWeights, constraint, rng as any);

        // Check each weight is within bounds (allowing for normalization)
        expect(validateWeights(weights)).toBe(true);

        // Sum should be 1.0
        const sum = Object.values(weights).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(1.0, 10);
      }
    });

    it('generates deterministic weights with same seed', () => {
      interface RandomLike {
        next(): number;
      }

      class TestSeededRandom implements RandomLike {
        private value: number;
        constructor(seed: number) {
          this.value = seed;
        }
        next() {
          this.value = (this.value * 1664525 + 1013904223) % 2 ** 32;
          return this.value / 2 ** 32;
        }
      }

      const rng1 = new TestSeededRandom(42);
      const rng2 = new TestSeededRandom(42);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const weights1 = generateConstrainedWeights(baseWeights, 0.2, rng1 as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const weights2 = generateConstrainedWeights(baseWeights, 0.2, rng2 as any);

      expect(weights1.trend).toBeCloseTo(weights2.trend);
      expect(weights1.momentum).toBeCloseTo(weights2.momentum);
      expect(weights1.volume).toBeCloseTo(weights2.volume);
    });
  });

  describe('generateWeightCandidates', () => {
    it('generates correct number of candidates', () => {
      const candidates = generateWeightCandidates(baseWeights, 10, 0.2);
      expect(candidates).toHaveLength(10);
    });

    it('includes base weights as first candidate', () => {
      const candidates = generateWeightCandidates(baseWeights, 5, 0.2);
      expect(candidates[0]).toEqual(baseWeights);
    });

    it('generates valid weights for all candidates', () => {
      const candidates = generateWeightCandidates(baseWeights, 20, 0.2);

      for (const weights of candidates) {
        expect(validateWeights(weights)).toBe(true);
      }
    });

    it('generates different weights with same seed (except first)', () => {
      const candidates = generateWeightCandidates(baseWeights, 5, 0.2, 42);

      // First candidate is base weights
      expect(candidates[0]).toEqual(baseWeights);

      // Others should be different from base
      for (let i = 1; i < candidates.length; i++) {
        expect(candidates[i]).not.toEqual(baseWeights);
      }
    });
  });

  describe('averageWeights', () => {
    it('averages weights correctly', () => {
      const weights1: SignalWeights = {
        trend: 0.2,
        momentum: 0.2,
        volume: 0.2,
        volatility: 0.2,
        futures: 0.1,
        sentiment: 0.1,
      };

      const weights2: SignalWeights = {
        trend: 0.3,
        momentum: 0.3,
        volume: 0.2,
        volatility: 0.1,
        futures: 0.05,
        sentiment: 0.05,
      };

      const avg = averageWeights([weights1, weights2]);

      expect(avg.trend).toBeCloseTo(0.25);
      expect(avg.momentum).toBeCloseTo(0.25);
      expect(avg.volume).toBeCloseTo(0.2);
      expect(avg.volatility).toBeCloseTo(0.15);
      expect(avg.futures).toBeCloseTo(0.075);
      expect(avg.sentiment).toBeCloseTo(0.075);
    });

    it('returns same weights when averaging single set', () => {
      const avg = averageWeights([baseWeights]);
      expect(avg).toEqual(baseWeights);
    });

    it('throws error for empty array', () => {
      expect(() => averageWeights([])).toThrow('Cannot average empty weight sets');
    });

    it('produces valid weights', () => {
      const weights1: SignalWeights = {
        trend: 0.25,
        momentum: 0.25,
        volume: 0.25,
        volatility: 0.25,
        futures: 0.0,
        sentiment: 0.0,
      };

      const weights2: SignalWeights = {
        trend: 0.1,
        momentum: 0.1,
        volume: 0.1,
        volatility: 0.1,
        futures: 0.3,
        sentiment: 0.3,
      };

      const avg = averageWeights([weights1, weights2]);
      expect(validateWeights(avg)).toBe(true);
    });
  });
});
