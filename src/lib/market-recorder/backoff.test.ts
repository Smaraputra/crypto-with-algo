import { describe, expect, it } from 'vitest';

import { DEFAULT_BACKOFF, backoffDelay } from './backoff';

describe('backoffDelay', () => {
  it('doubles the ceiling per attempt from the base', () => {
    // random() = 1 gives the ceiling itself.
    const ceilings = [0, 1, 2, 3, 4].map((attempt) => backoffDelay(attempt, () => 1));

    expect(ceilings).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it('never exceeds the cap however many attempts have failed', () => {
    expect(backoffDelay(6, () => 1)).toBe(DEFAULT_BACKOFF.maxMs);
    expect(backoffDelay(50, () => 1)).toBe(DEFAULT_BACKOFF.maxMs);
    expect(backoffDelay(10_000, () => 1)).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it('jitters between half the ceiling and the ceiling', () => {
    expect(backoffDelay(3, () => 0)).toBe(4_000);
    expect(backoffDelay(3, () => 0.5)).toBe(6_000);
    expect(backoffDelay(3, () => 1)).toBe(8_000);

    for (let i = 0; i < 200; i++) {
      const delay = backoffDelay(10, Math.random);
      expect(delay).toBeGreaterThanOrEqual(DEFAULT_BACKOFF.maxMs / 2);
      expect(delay).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
    }
  });

  it('treats a negative or fractional attempt as the nearest valid one', () => {
    expect(backoffDelay(-3, () => 1)).toBe(1_000);
    expect(backoffDelay(1.9, () => 1)).toBe(2_000);
  });

  it('honours custom options', () => {
    expect(backoffDelay(2, () => 1, { baseMs: 100, maxMs: 300 })).toBe(300);
    expect(backoffDelay(1, () => 0, { baseMs: 100, maxMs: 300 })).toBe(100);
  });
});
