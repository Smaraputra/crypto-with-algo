import { describe, it, expect } from 'vitest';
import { createSeededRandom } from './seeded-random';
import { normalCdf, normalQuantile, sampleSkewness, sampleKurtosis } from './normal';

describe('normal', () => {
  describe('normalCdf', () => {
    it('normalCdf(0) = 0.5', () => {
      expect(normalCdf(0)).toBeCloseTo(0.5, 10);
    });

    it('normalCdf(1.959964) is close to 0.975', () => {
      expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    });

    it('normalCdf(-1.959964) is close to 0.025', () => {
      expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 6);
    });

    it('is monotonically increasing', () => {
      expect(normalCdf(-1)).toBeLessThan(normalCdf(0));
      expect(normalCdf(0)).toBeLessThan(normalCdf(1));
    });

    // Reference values from a high-precision normal CDF table. Large |x| is
    // where a naive series-based erf suffers catastrophic cancellation, so
    // this is the regression coverage for that failure mode.
    const referenceTable: Array<[number, number]> = [
      [0, 0.5],
      [0.5, 0.6914624613],
      [1, 0.8413447461],
      [1.959964, 0.975],
      [2.575829, 0.995],
      [3, 0.9986501020],
      [4, 0.9999683288],
      [5, 0.9999997133],
      [6, 0.999999999],
      [8, 1],
      [10, 1],
    ];

    it.each(referenceTable)('normalCdf(%f) is within 1e-7 of %f', (x, expected) => {
      expect(Math.abs(normalCdf(x) - expected)).toBeLessThan(1e-7);
    });

    it.each(referenceTable)('normalCdf(-%f) is within 1e-7 of 1 - %f', (x, expected) => {
      expect(Math.abs(normalCdf(-x) - (1 - expected))).toBeLessThan(1e-7);
    });

    it('stays within [0, 1] and is symmetric (Phi(x) + Phi(-x) = 1) over a wide grid', () => {
      for (let x = -40; x <= 40; x += 0.5) {
        const value = normalCdf(x);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
        expect(Math.abs(value + normalCdf(-x) - 1)).toBeLessThan(1e-12);
      }
    });

    it('is monotone non-decreasing over a wide grid', () => {
      let previous = -Infinity;
      for (let x = -40; x <= 40; x += 0.25) {
        const value = normalCdf(x);
        expect(value).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
    });
  });

  describe('normalQuantile', () => {
    it('normalQuantile(0.975) is close to 1.959964', () => {
      expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 6);
    });

    it('normalQuantile(0.5) is 0', () => {
      expect(normalQuantile(0.5)).toBeCloseTo(0, 8);
    });

    it('throws outside (0, 1)', () => {
      expect(() => normalQuantile(0)).toThrow();
      expect(() => normalQuantile(1)).toThrow();
      expect(() => normalQuantile(-0.1)).toThrow();
      expect(() => normalQuantile(1.1)).toThrow();
    });

    it('round-trips with normalCdf over a grid of probabilities', () => {
      const grid = [0.01, 0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95, 0.99];
      for (const p of grid) {
        const x = normalQuantile(p);
        expect(normalCdf(x)).toBeCloseTo(p, 6);
      }
    });

    it('round-trips with normalCdf over a grid of x values', () => {
      const grid = [-2.5, -1, -0.3, 0, 0.3, 1, 2.5];
      for (const x of grid) {
        const p = normalCdf(x);
        expect(normalQuantile(p)).toBeCloseTo(x, 5);
      }
    });
  });

  describe('sampleSkewness', () => {
    it('is close to 0 for a symmetric sample', () => {
      const symmetric = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
      expect(sampleSkewness(symmetric)).toBeCloseTo(0, 10);
    });

    it('is positive for a right-skewed sample', () => {
      const rightSkewed = [1, 1, 1, 1, 1, 2, 3, 20];
      expect(sampleSkewness(rightSkewed)).toBeGreaterThan(0);
    });
  });

  describe('sampleKurtosis', () => {
    it('is close to 3 for a large seeded normal sample', () => {
      const random = createSeededRandom(555);
      // Box-Muller transform to generate approximately normal samples.
      const normals: number[] = [];
      for (let i = 0; i < 20000; i++) {
        const u1 = random();
        const u2 = random();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        normals.push(z);
      }
      expect(sampleKurtosis(normals)).toBeCloseTo(3, 0);
    });
  });
});
