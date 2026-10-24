import { describe, expect, it } from 'vitest';
import { LAB_V4_ROUND_TRIP } from '@/lib/signals/lab/candidates';
import { labV4Outcome } from './outcome';

describe('labV4Outcome', () => {
  it('returns won when return exceeds round trip cost', () => {
    // Long trade: +1% move
    const longWon = labV4Outcome(1, 100, 101);
    expect(longWon.move).toBeCloseTo(0.01, 8);
    expect(longWon.outcome).toBe('won');

    // Short trade: price falls 2%
    const shortWon = labV4Outcome(-1, 100, 98);
    expect(shortWon.move).toBeCloseTo(-0.02, 8);
    expect(shortWon.outcome).toBe('won');
  });

  it('returns cost when price moves in direction but does not exceed round trip cost', () => {
    // Long trade: +0.05% move (less than 0.14% cost)
    const longCost = labV4Outcome(1, 10000, 10005);
    expect(longCost.move).toBeCloseTo(0.0005, 8);
    expect(longCost.outcome).toBe('cost');

    // Short trade: price falls 0.05%
    const shortCost = labV4Outcome(-1, 10000, 9995);
    expect(shortCost.move).toBeCloseTo(-0.0005, 8);
    expect(shortCost.outcome).toBe('cost');
  });

  it('returns cost at the exact cost boundary (d === LAB_V4_ROUND_TRIP)', () => {
    // 14 / 10000 is exactly 0.0014 (LAB_V4_ROUND_TRIP)
    const longBoundary = labV4Outcome(1, 10000, 10014);
    expect(longBoundary.move).toBe(LAB_V4_ROUND_TRIP);
    expect(longBoundary.outcome).toBe('cost');

    const shortBoundary = labV4Outcome(-1, 10000, 9986);
    expect(shortBoundary.move).toBe(-LAB_V4_ROUND_TRIP);
    expect(shortBoundary.outcome).toBe('cost');
  });

  it('returns wrong when move is against side or flat', () => {
    // Long trade with price drop
    const longWrong = labV4Outcome(1, 100, 99);
    expect(longWrong.outcome).toBe('wrong');

    // Short trade with price rise
    const shortWrong = labV4Outcome(-1, 100, 101);
    expect(shortWrong.outcome).toBe('wrong');

    // Flat price
    const flat = labV4Outcome(1, 100, 100);
    expect(flat.move).toBe(0);
    expect(flat.outcome).toBe('wrong');
  });
});
