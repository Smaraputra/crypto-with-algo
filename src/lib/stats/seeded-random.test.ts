import { describe, it, expect } from 'vitest';
import { createSeededRandom } from './seeded-random';

describe('seeded-random', () => {
  it('is deterministic for a given seed', () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('returns values within [0, 1)', () => {
    const random = createSeededRandom(1234);
    for (let i = 0; i < 5000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('does not repeat the same value on consecutive calls', () => {
    const random = createSeededRandom(7);
    const first = random();
    const second = random();
    expect(first).not.toBe(second);
  });
});
