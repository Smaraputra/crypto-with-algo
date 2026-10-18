import { describe, expect, it } from 'vitest';

import { addMonthsUtc, labStatus, rankCoins } from './view';

describe('view pure helpers', () => {
  describe('addMonthsUtc', () => {
    it('adds 24 calendar months in UTC', () => {
      expect(addMonthsUtc(Date.UTC(2026, 9, 18, 8), 24)).toBe(Date.UTC(2028, 9, 18, 8));
    });
  });

  describe('labStatus', () => {
    const firstGraded = Date.UTC(2026, 9, 18, 8);
    const testEndsAt = addMonthsUtc(firstGraded, 24);

    it('returns not_started when there is no graded bar', () => {
      expect(labStatus({ firstGradedAt: null, crossedAt: null, now: firstGraded })).toBe('not_started');
    });

    it('returns under_test when there is a graded bar and no crossing within 24 months', () => {
      expect(
        labStatus({
          firstGradedAt: firstGraded,
          crossedAt: null,
          now: firstGraded + 30 * 24 * 3600 * 1000,
        })
      ).toBe('under_test');
    });

    it('returns validated when crossedAt is set even past 24 months', () => {
      expect(
        labStatus({
          firstGradedAt: firstGraded,
          crossedAt: firstGraded + 10_000,
          now: testEndsAt + 1_000,
        })
      ).toBe('validated');
    });

    it('returns not_shown past addMonthsUtc(first, 24) without a crossing', () => {
      expect(
        labStatus({
          firstGradedAt: firstGraded,
          crossedAt: null,
          now: testEndsAt + 1,
        })
      ).toBe('not_shown');
    });
  });

  describe('rankCoins', () => {
    it('ranks descending by score', () => {
      expect(rankCoins({ A: 1, B: 3, C: 2 })).toEqual([
        { symbol: 'B', score: 3, rank: 1 },
        { symbol: 'C', score: 2, rank: 2 },
        { symbol: 'A', score: 1, rank: 3 },
      ]);
    });

    it('breaks ties using symbol name in alphabetical order', () => {
      expect(rankCoins({ SOLUSDT: 5, BTCUSDT: 10, ETHUSDT: 10 })).toEqual([
        { symbol: 'BTCUSDT', score: 10, rank: 1 },
        { symbol: 'ETHUSDT', score: 10, rank: 2 },
        { symbol: 'SOLUSDT', score: 5, rank: 3 },
      ]);
    });
  });
});
