import { describe, expect, it } from 'vitest';
import { bookTurnover, hurdle, LAB_COST_PER_SIDE, LAB_S_WINDOW, trailingS } from './hurdle';

describe('hurdle', () => {
  describe('constants', () => {
    it('exports expected constants', () => {
      expect(LAB_COST_PER_SIDE).toBe(0.0007);
      expect(LAB_S_WINDOW).toBe(90);
    });
  });

  describe('bookTurnover', () => {
    it('computes flat entry cost with null prev', () => {
      expect(bookTurnover(null, { A: 0.5, B: -0.5 })).toBe(1);
    });

    it('returns zero when portfolio is unchanged', () => {
      expect(bookTurnover({ A: 0.5, B: -0.5 }, { A: 0.5, B: -0.5 })).toBe(0);
    });

    it('computes turnover over union of symbols with additions and removals', () => {
      // A changes from 0.5 to -0.5 (delta = 1)
      // B changes from -0.5 to 0 (delta = 0.5)
      // C changes from 0 to 0.5 (delta = 0.5)
      // total = 1 + 0.5 + 0.5 = 2
      expect(bookTurnover({ A: 0.5, B: -0.5 }, { A: -0.5, C: 0.5 })).toBe(2);
    });
  });

  describe('trailingS', () => {
    it('returns null on empty input', () => {
      expect(trailingS([], 90)).toBeNull();
    });

    it('averages all entries when fewer than window', () => {
      expect(trailingS([1, 2, 3])).toBe(2);
    });

    it('averages only the last window elements', () => {
      const pastS = Array.from({ length: 100 }, (_, i) => i + 1);
      // Last 90 values are 11..100, mean is (11 + 100) / 2 = 55.5
      expect(trailingS(pastS, 90)).toBe(55.5);
    });

    it('ignores non-finite entries', () => {
      expect(trailingS([NaN, 2, 4])).toBe(3);
    });

    it('returns null when no finite entries exist in the window', () => {
      expect(trailingS([NaN])).toBeNull();
      expect(trailingS([Infinity, -Infinity])).toBeNull();
    });
  });

  describe('hurdle formula', () => {
    it('computes b_t for valid input', () => {
      const val = hurdle({ turnover: 1, kN: 1.1489, sHat: 0.01 });
      expect(val).toBeCloseTo(0.0007 / 0.011489, 12);
    });

    it('returns null on degenerate inputs', () => {
      expect(hurdle({ turnover: 1, kN: 1.1489, sHat: null })).toBeNull();
      expect(hurdle({ turnover: 1, kN: 1.1489, sHat: 0 })).toBeNull();
      expect(hurdle({ turnover: 1, kN: 1.1489, sHat: -0.05 })).toBeNull();
      expect(hurdle({ turnover: 1, kN: NaN, sHat: 0.01 })).toBeNull();
      expect(hurdle({ turnover: 1, kN: 0, sHat: 0.01 })).toBeNull();
      expect(hurdle({ turnover: 1, kN: -1, sHat: 0.01 })).toBeNull();
      expect(hurdle({ turnover: -1, kN: 1.1489, sHat: 0.01 })).toBeNull();
      expect(hurdle({ turnover: NaN, kN: 1.1489, sHat: 0.01 })).toBeNull();
    });
  });
});
