import { describe, it, expect } from 'vitest';

import {
  MIN_BARS_FOR_A_DAY,
  accumulateDays,
  dayBucket,
  p90PerDay,
  percentileOf,
  quantile,
} from './daily-p90';

const DAY = 86_400_000;

describe('dayBucket', () => {
  it('floors to UTC midnight', () => {
    expect(dayBucket(Date.parse('2026-09-25T00:00:00Z'))).toBe(Date.parse('2026-09-25T00:00:00Z'));
    expect(dayBucket(Date.parse('2026-09-25T23:59:59Z'))).toBe(Date.parse('2026-09-25T00:00:00Z'));
    expect(dayBucket(Date.parse('2026-09-26T00:00:00Z'))).toBe(Date.parse('2026-09-26T00:00:00Z'));
  });
});

describe('quantile', () => {
  it('takes the nearest rank of a sorted array', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(sorted, 0)).toBe(1);
    expect(quantile(sorted, 0.5)).toBe(6);
    expect(quantile(sorted, 0.9)).toBe(10);
    expect(quantile(sorted, 1)).toBe(10);
  });

  it('is NaN on an empty series rather than throwing or returning zero', () => {
    expect(quantile([], 0.9)).toBeNaN();
  });
});

describe('accumulateDays', () => {
  it('buckets by UTC day and takes the absolute value', () => {
    const base = Date.parse('2026-09-25T00:00:00Z');
    const buckets = accumulateDays([base, base + 3600_000, base + DAY], [-5, 10, -20]);

    expect([...buckets.keys()].sort()).toEqual([base, base + DAY]);
    expect(buckets.get(base)).toEqual([5, 10]);
    expect(buckets.get(base + DAY)).toEqual([20]);
  });

  it('drops non-finite values instead of counting them as zero', () => {
    // A bar with a missing input must stay out of the distribution; counting it
    // as 0 would drag every percentile down and look like a quiet market.
    const base = Date.parse('2026-09-25T00:00:00Z');
    const buckets = accumulateDays([base, base, base], [Number.NaN, 30, Number.POSITIVE_INFINITY]);

    expect(buckets.get(base)).toEqual([30]);
  });

  it('accumulates across several calls, which is how symbols are pooled', () => {
    const base = Date.parse('2026-09-25T00:00:00Z');
    const buckets = accumulateDays([base], [1]);
    accumulateDays([base], [2], buckets);

    expect(buckets.get(base)).toEqual([1, 2]);
  });
});

describe('p90PerDay', () => {
  it('drops partial days, which the first and last day of any export are', () => {
    const base = Date.parse('2026-09-25T00:00:00Z');
    const full = Array.from({ length: MIN_BARS_FOR_A_DAY }, (_, i) => i + 1);
    const partial = [1, 2, 3];

    const buckets = new Map([
      [base, full],
      [base + DAY, partial],
    ]);

    const days = p90PerDay(buckets);
    expect(days).toHaveLength(1);
    expect(days[0].day).toBe(base);
  });

  it('returns days in chronological order regardless of insertion order', () => {
    const base = Date.parse('2026-09-25T00:00:00Z');
    const full = () => Array.from({ length: MIN_BARS_FOR_A_DAY }, () => 10);

    const buckets = new Map([
      [base + 2 * DAY, full()],
      [base, full()],
      [base + DAY, full()],
    ]);

    expect(p90PerDay(buckets).map((d) => d.day)).toEqual([base, base + DAY, base + 2 * DAY]);
  });
});

describe('percentileOf', () => {
  it('reports where a value sits among the days', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentileOf(sorted, 1)).toBe(0);
    expect(percentileOf(sorted, 51)).toBe(50);
    expect(percentileOf(sorted, 101)).toBe(100);
  });

  it('is the number the 2026-09-25 investigation turned on', () => {
    // A live p90 of 23.9 read as an 8-point shortfall against the pooled 32.2,
    // and was an ordinary soft day once the spread of days was known.
    const days = [11.3, 22.2, 24.4, 27.5, 30.7, 33.7, 38.3, 42.8];
    expect(percentileOf(days, 23.9)).toBeCloseTo(25, 0);
  });
});
