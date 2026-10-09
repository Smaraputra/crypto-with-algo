import { describe, it, expect } from 'vitest';
import {
  monthlyThresholds,
  tailFlags,
  atrQuintiles,
  monthIndex,
  monthStart,
  TAIL_PROBS,
  TAIL_TOP_1,
  TAIL_BOTTOM_1,
  TAIL_TOP_10,
  TAIL_BOTTOM_10,
} from './snipe-tails';

const DAY = 86_400_000;
const FEB = Date.UTC(2023, 1, 1);
const JAN = Date.UTC(2023, 0, 1);

/** Daily bars from `start` for `days` days. */
function daily(start: number, days: number): number[] {
  return Array.from({ length: days }, (_, i) => start + i * DAY);
}

describe('monthIndex', () => {
  it('is year x 12 + month in UTC', () => {
    expect(monthIndex(Date.UTC(2024, 0, 1))).toBe(2024 * 12);
    expect(monthIndex(Date.UTC(2024, 11, 31, 23, 59))).toBe(2024 * 12 + 11);
    expect(monthIndex(Date.UTC(2023, 11, 31, 23, 59, 59) + 1000)).toBe(2024 * 12);
  });
});

describe('monthlyThresholds', () => {
  it('uses type 7 interpolation on the strictly preceding window', () => {
    // 31 daily values 1..31 in January, query February with lookback 31 days.
    const ts = daily(JAN, 31).concat([FEB]);
    const vals = Float64Array.from([...Array.from({ length: 31 }, (_, i) => i + 1), 999]);
    const th = monthlyThresholds(ts, vals, [0, 0.25, 0.5, 0.99, 1], 31, DAY);
    const q = th.get(FEB)!;
    // n = 31: h = 30p. p=0.25 -> 7.5 -> 8 + 0.5 = 8.5; p=0.5 -> 15 -> 16; p=0.99 -> 29.7 -> 30.7
    expect(q[0]).toBe(1);
    expect(q[1]).toBeCloseTo(8.5, 12);
    expect(q[2]).toBe(16);
    expect(q[3]).toBeCloseTo(30.7, 12);
    expect(q[4]).toBe(31);
  });

  it('matches a hand-computed even-count quantile', () => {
    // values 10, 20, 30, 40: h = 3p. p=0.5 -> 1.5 -> 25; p=0.9 -> 2.7 -> 30 + 0.7 x 10 = 37
    const ts = [JAN, JAN + DAY, JAN + 2 * DAY, JAN + 3 * DAY, FEB];
    const th = monthlyThresholds(ts, Float64Array.from([10, 20, 30, 40, 0]), [0.5, 0.9], 4, DAY);
    // window [FEB - 4d, FEB) holds only Jan 28..31, none of our values: too thin
    expect(th.get(FEB)).toBeNull();
    const ts2 = [FEB - 4 * DAY, FEB - 3 * DAY, FEB - 2 * DAY, FEB - DAY, FEB];
    const th2 = monthlyThresholds(ts2, Float64Array.from([10, 20, 30, 40, 0]), [0.5, 0.9], 4, DAY);
    const q = th2.get(FEB)!;
    expect(q[0]).toBeCloseTo(25, 12);
    expect(q[1]).toBeCloseTo(37, 12);
  });

  it('is causal: values at or after the month start never enter that month', () => {
    const ts = [...daily(JAN, 31), FEB, FEB + DAY];
    const base = Array.from({ length: 31 }, (_, i) => i + 1);
    const a = monthlyThresholds(ts, Float64Array.from([...base, 1e9, 1e9]), TAIL_PROBS, 31, DAY);
    const b = monthlyThresholds(ts, Float64Array.from([...base, -1e9, -1e9]), TAIL_PROBS, 31, DAY);
    expect(Array.from(a.get(FEB)!)).toEqual(Array.from(b.get(FEB)!));
  });

  it('excludes values older than the lookback', () => {
    const ts = [FEB - 3 * DAY, FEB - 2 * DAY, FEB - DAY, FEB];
    const th = monthlyThresholds(ts, Float64Array.from([1000, 1, 3, 0]), [0, 1], 2, DAY);
    const q = th.get(FEB)!;
    expect(q[0]).toBe(1);
    expect(q[1]).toBe(3);
  });

  it('returns null when the window holds under half of the expected bars, and accepts exactly half', () => {
    // lookback 4 days of daily bars: expected 4, need >= 2
    const one = monthlyThresholds([FEB - DAY, FEB], Float64Array.from([1, 0]), [0.5], 4, DAY);
    expect(one.get(FEB)).toBeNull();
    const two = monthlyThresholds([FEB - 2 * DAY, FEB - DAY, FEB], Float64Array.from([1, 3, 0]), [0.5], 4, DAY);
    expect(two.get(FEB)![0]).toBe(2);
  });

  it('counts only finite values toward the half rule and the quantiles', () => {
    const ts = [FEB - 3 * DAY, FEB - 2 * DAY, FEB - DAY, FEB];
    const th = monthlyThresholds(ts, Float64Array.from([Number.NaN, Number.NaN, 5, 0]), [0.5], 4, DAY);
    expect(th.get(FEB)).toBeNull();
    const ok = monthlyThresholds(ts, Float64Array.from([Number.NaN, 4, 6, 0]), [0.5], 4, DAY);
    expect(ok.get(FEB)![0]).toBe(5);
  });

  it('gives the first month no thresholds (no history)', () => {
    const th = monthlyThresholds(daily(JAN, 5), new Float64Array(5), [0.5], 31, DAY);
    expect(th.get(JAN)).toBeNull();
  });
});

describe('tailFlags', () => {
  // Window: Jan 1..31 with values 1..31, so q01 = 1.3, q10 = 4, q90 = 28, q99 = 30.7 (h = 30p).
  const ts = [...daily(JAN, 31), FEB, FEB + DAY, FEB + 2 * DAY, FEB + 3 * DAY, FEB + 4 * DAY, FEB + 5 * DAY];
  const jan = Array.from({ length: 31 }, (_, i) => i + 1);
  const th = monthlyThresholds(ts, Float64Array.from([...jan, 0, 0, 0, 0, 0, 0]), TAIL_PROBS, 31, DAY);

  it('flags with >= and <= at exact equality', () => {
    const q = th.get(FEB)!;
    expect(q[1]).toBeCloseTo(4, 12);
    expect(q[2]).toBeCloseTo(28, 12);
    const feb = [q[1], q[2], q[0], q[3], 15, Number.NaN];
    const f = tailFlags(ts, Float64Array.from([...jan, ...feb]), th);
    const out = Array.from(f.slice(31));
    expect(out[0]).toBe(TAIL_BOTTOM_10);
    expect(out[1]).toBe(TAIL_TOP_10);
    expect(out[2]).toBe(TAIL_BOTTOM_1 | TAIL_BOTTOM_10);
    expect(out[3]).toBe(TAIL_TOP_1 | TAIL_TOP_10);
    expect(out[4]).toBe(0);
    expect(out[5]).toBe(0);
  });

  it('gives all zero flags in a month without thresholds', () => {
    const f = tailFlags(ts, Float64Array.from([...jan, 0, 0, 0, 0, 0, 0]), th);
    expect(Array.from(f.slice(0, 31)).every((x) => x === 0)).toBe(true);
  });

  it('uses the bar own month thresholds', () => {
    const march = Date.UTC(2023, 2, 1);
    const ts2 = [...daily(JAN, 31), ...daily(FEB, 28), march];
    const vals = Float64Array.from([...jan, ...Array.from({ length: 28 }, (_, i) => 101 + i), 5]);
    const th2 = monthlyThresholds(ts2, vals, TAIL_PROBS, 28, DAY);
    const f = tailFlags(ts2, vals, th2);
    // Feb 1 (101) is far above January's window; March 1 (5) is far below February's window.
    expect(f[31]).toBe(TAIL_TOP_1 | TAIL_TOP_10);
    expect(f[ts2.length - 1]).toBe(TAIL_BOTTOM_1 | TAIL_BOTTOM_10);
  });
});

describe('atrQuintiles', () => {
  const ts = [...daily(JAN, 31), FEB, FEB + DAY, FEB + 2 * DAY, FEB + 3 * DAY, FEB + 4 * DAY, FEB + 5 * DAY, FEB + 6 * DAY];
  // n = 31 values 1..31, h = 30p: q20 = 7, q40 = 13, q60 = 19, q80 = 25.
  const jan = Array.from({ length: 31 }, (_, i) => i + 1);

  it('bins by <= edges and returns -1 when unavailable', () => {
    const feb = [7, 7.01, 13, 19, 25, 25.01, Number.NaN];
    const q = atrQuintiles(ts, Float64Array.from([...jan, ...feb]), 31, DAY);
    expect(Array.from(q.slice(31))).toEqual([0, 1, 1, 2, 3, 4, -1]);
    expect(Array.from(q.slice(0, 31)).every((x) => x === -1)).toBe(true);
  });
});

describe('monthStart', () => {
  it('floors to the UTC month start', () => {
    expect(monthStart(Date.UTC(2023, 1, 17, 5))).toBe(FEB);
  });
});
