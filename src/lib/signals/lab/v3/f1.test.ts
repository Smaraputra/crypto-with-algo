// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  computeFund7,
  DAY_MS,
  MIN_SCORED_COINS,
  MIN_SETTLEMENTS_7D,
  staggeredBook,
  targetBook,
} from './f1';

describe('computeFund7', () => {
  const barClose = Date.parse('2026-10-20T00:00:00.000Z');

  it('returns null when settlements count is below threshold (18)', () => {
    const settlements = Array.from({ length: 17 }, (_, i) => ({
      t: barClose - (i + 1) * (8 * 3600_000),
      rate: 0.0001,
    }));
    const res = computeFund7(settlements, barClose);
    expect(res.count).toBe(17);
    expect(res.fund7).toBeNull();
  });

  it('returns -sum when count is >= 18', () => {
    // 20 settlements spaced 8h apart inside the 7d window
    const settlements = Array.from({ length: 20 }, (_, i) => ({
      t: barClose - (i + 0.5) * (8 * 3600_000),
      rate: 0.0002,
    }));
    const res = computeFund7(settlements, barClose);
    expect(res.count).toBe(20);
    expect(res.fund7).toBeCloseTo(-0.004, 6);
  });

  it('ignores settlements outside the (barClose - 7d, barClose] window', () => {
    const settlements = [
      // inside
      ...Array.from({ length: 18 }, (_, i) => ({
        t: barClose - (i + 1) * (8 * 3600_000),
        rate: 0.0001,
      })),
      // after barClose
      { t: barClose + 1000, rate: 0.05 },
      // before barClose - 7d
      { t: barClose - 8 * DAY_MS, rate: 0.05 },
    ];
    const res = computeFund7(settlements, barClose);
    expect(res.count).toBe(18);
    expect(res.fund7).toBeCloseTo(-0.0018, 6);
  });
});

describe('targetBook', () => {
  it('returns empty map if fewer than MIN_SCORED_COINS are present', () => {
    const scores = Array.from({ length: 7 }, (_, i) => ({
      symbol: `COIN${i}`,
      score: i,
    }));
    const book = targetBook(scores);
    expect(book.size).toBe(0);
  });

  it('forms dollar-neutral, gross-1 weights across eligible coins', () => {
    const scores = Array.from({ length: 10 }, (_, i) => ({
      symbol: `COIN${String.fromCharCode(65 + i)}`,
      score: i * 0.01,
    }));
    const book = targetBook(scores);
    expect(book.size).toBe(10);

    let sum = 0;
    let absSum = 0;
    for (const w of book.values()) {
      sum += w;
      absSum += Math.abs(w);
    }
    expect(sum).toBeCloseTo(0, 10);
    expect(absSum).toBeCloseTo(1, 10);

    // Coin with highest score has positive weight, lowest has negative weight
    expect(book.get('COINJ')!).toBeGreaterThan(0);
    expect(book.get('COINA')!).toBeLessThan(0);
  });
});

describe('staggeredBook', () => {
  it('averages target books across 7 days with equal 1/7 weights', () => {
    const target1 = new Map([
      ['BTC', 0.5],
      ['ETH', -0.5],
    ]);
    const target2 = new Map([
      ['BTC', 0.5],
      ['ETH', -0.5],
    ]);

    // Only 2 days provided, each contributes 1/7
    const staggered = staggeredBook([target1, target2]);
    expect(staggered.get('BTC')).toBeCloseTo(1.0 / 7, 8);
    expect(staggered.get('ETH')).toBeCloseTo(-1.0 / 7, 8);
  });

  it('sums to 0 and gross 1 when all 7 days have identical gross-1 targets', () => {
    const target = new Map([
      ['SOL', 0.5],
      ['DOGE', -0.5],
    ]);
    const targets = Array.from({ length: 7 }, () => target);

    const staggered = staggeredBook(targets);
    expect(staggered.get('SOL')).toBeCloseTo(0.5, 8);
    expect(staggered.get('DOGE')).toBeCloseTo(-0.5, 8);
  });
});
