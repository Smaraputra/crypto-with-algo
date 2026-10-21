// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { shiftToSharpe, tailCounts } from './lab-v3-power';

function computeAnnualSharpe(arr: number[]): number {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - mean;
    sumSq += d * d;
  }
  const variance = sumSq / (n - 1);
  const sd = Math.sqrt(variance);
  return (mean / sd) * Math.sqrt(365);
}

describe('lab-v3-power', () => {
  describe('shiftToSharpe', () => {
    it('gives the requested Sharpe to 1e-9 on a synthetic series', () => {
      const syntheticR = [
        0.005, -0.012, 0.008, 0.021, -0.003, -0.015, 0.002, 0.018, -0.007, 0.011,
      ];
      const targetSharpes = [0, 0.82, 1, 1.5, 2, 2.5, -0.5];

      for (const target of targetSharpes) {
        const shifted = shiftToSharpe(syntheticR, target);
        const actualSharpe = computeAnnualSharpe(shifted);
        expect(Math.abs(actualSharpe - target)).toBeLessThan(1e-9);
      }
    });
  });

  describe('tailCounts', () => {
    it('counts a hand-built series correctly', () => {
      const c = 0.036;
      // c = 0.036
      // -0.04 / 0.036 = -1.111 (< -1, not < -2)
      // -0.08 / 0.036 = -2.222 (< -1, < -2)
      // 0.04 / 0.036 = +1.111 (> 1)
      // 0.01 / 0.036 = +0.278 (normal)
      // -0.02 / 0.036 = -0.556 (normal)
      const handBuilt = [-0.04, -0.08, 0.04, 0.01, -0.02];
      const counts = tailCounts(handBuilt, c);

      expect(counts).toEqual({
        belowMinus1: 2,
        belowMinus2: 1,
        gainClipped: 1,
      });
    });
  });
});
