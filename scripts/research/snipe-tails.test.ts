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
  TAIL_ELIGIBLE,
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
    const th = monthlyThresholds(ts, vals, [0, 0.25, 0.5, 0.99, 1], 31, DAY, 1);
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
    const th = monthlyThresholds(ts, Float64Array.from([10, 20, 30, 40, 0]), [0.5, 0.9], 4, DAY, 1);
    // window [FEB - 4d, FEB) holds only Jan 28..31, none of our values: too thin
    expect(th.get(FEB)).toBeNull();
    const ts2 = [FEB - 4 * DAY, FEB - 3 * DAY, FEB - 2 * DAY, FEB - DAY, FEB];
    const th2 = monthlyThresholds(ts2, Float64Array.from([10, 20, 30, 40, 0]), [0.5, 0.9], 4, DAY, 1);
    const q = th2.get(FEB)!;
    expect(q[0]).toBeCloseTo(25, 12);
    expect(q[1]).toBeCloseTo(37, 12);
  });

  it('is causal: values at or after the month start never enter that month', () => {
    const ts = [...daily(JAN, 31), FEB, FEB + DAY];
    const base = Array.from({ length: 31 }, (_, i) => i + 1);
    const a = monthlyThresholds(ts, Float64Array.from([...base, 1e9, 1e9]), TAIL_PROBS, 31, DAY, 1);
    const b = monthlyThresholds(ts, Float64Array.from([...base, -1e9, -1e9]), TAIL_PROBS, 31, DAY, 1);
    expect(Array.from(a.get(FEB)!)).toEqual(Array.from(b.get(FEB)!));
  });

  it('excludes values older than the lookback', () => {
    const ts = [FEB - 3 * DAY, FEB - 2 * DAY, FEB - DAY, FEB];
    const th = monthlyThresholds(ts, Float64Array.from([1000, 1, 3, 0]), [0, 1], 2, DAY, 1);
    const q = th.get(FEB)!;
    expect(q[0]).toBe(1);
    expect(q[1]).toBe(3);
  });

  it('returns null when the window holds under half of the expected bars as ROWS, and accepts exactly half (A2-1)', () => {
    // lookback 4 days of daily bars: expected 4 rows, need >= 2 present (whatever their values)
    // (the series starts at FEB - 4d so the full lookback exists)
    const one = monthlyThresholds([FEB - 4 * DAY, FEB], Float64Array.from([1, 0]), [0.5], 4, DAY, 1);
    expect(one.get(FEB)).toBeNull();
    const nan = Number.NaN;
    // two rows present, one of them NaN: the rows rule passes and the one finite value sets the quantile
    const two = monthlyThresholds([FEB - 4 * DAY, FEB - DAY, FEB], Float64Array.from([nan, 1, 0]), [0.5], 4, DAY, 1);
    expect(two.get(FEB)![0]).toBe(1);
  });

  it('needs minValues finite values in the window, and quantiles only over finite values (A2-1)', () => {
    const ts = [FEB - 4 * DAY, FEB - 3 * DAY, FEB - 2 * DAY, FEB - DAY, FEB];
    const nan = Number.NaN;
    const th = monthlyThresholds(ts, Float64Array.from([nan, nan, nan, 5, 0]), [0.5], 4, DAY, 2);
    expect(th.get(FEB)).toBeNull();
    const ok = monthlyThresholds(ts, Float64Array.from([nan, nan, 4, 6, 0]), [0.5], 4, DAY, 2);
    expect(ok.get(FEB)![0]).toBe(5);
  });

  it('gives a regime column (NaN outside its regime) thresholds once it has the default minimum of finite values (A2-1)', () => {
    const HOUR = 3_600_000;
    const start = Date.UTC(2022, 0, 1);
    const n = 24 * 130; // 130 days of hourly rows
    const ts = Float64Array.from({ length: n }, (_, i) => start + i * HOUR);
    const may = Date.UTC(2022, 4, 1);
    // finite on every 4th row: 90 days hold 540 finite values, above the default 200
    const dense = Float64Array.from({ length: n }, (_, i) => (i % 4 === 0 ? i % 97 : Number.NaN));
    expect(monthlyThresholds(ts, dense, [0.5], 90, HOUR).get(may)).not.toBeNull();
    // finite on every 20th row: 108 finite values, below the default 200
    const sparse = Float64Array.from({ length: n }, (_, i) => (i % 20 === 0 ? i % 97 : Number.NaN));
    expect(monthlyThresholds(ts, sparse, [0.5], 90, HOUR).get(may)).toBeNull();
  });

  it('gives the first month no thresholds (no history)', () => {
    const th = monthlyThresholds(daily(JAN, 5), new Float64Array(5), [0.5], 31, DAY, 1);
    expect(th.get(JAN)).toBeNull();
  });

  it('needs the full lookback of history: a series starting mid-month has none until 90 days in (A1-2)', () => {
    // Daily bars from 2023-01-20; the first month start at least 90 days after that is 2023-05-01 (Apr 20 + 11 d).
    const start = Date.UTC(2023, 0, 20);
    const ts = daily(start, 200);
    const vals = Float64Array.from(ts, (_, i) => i);
    const th = monthlyThresholds(ts, vals, [0.5], 90, DAY, 1);
    for (const m of [Date.UTC(2023, 0, 1), Date.UTC(2023, 1, 1), Date.UTC(2023, 2, 1), Date.UTC(2023, 3, 1)]) {
      expect(th.get(m)).toBeNull();
    }
    const may = Date.UTC(2023, 4, 1);
    expect(may - 90 * DAY).toBeGreaterThanOrEqual(start);
    expect(th.get(may)).not.toBeNull();
    expect(th.get(Date.UTC(2023, 5, 1))).not.toBeNull();
    // Exactly 90 days of history is enough, one millisecond less is not.
    const exact = monthlyThresholds(daily(may - 90 * DAY, 100), new Float64Array(100), [0.5], 90, DAY, 1);
    expect(exact.get(may)).not.toBeNull();
    const late = monthlyThresholds(daily(may - 90 * DAY + 1, 100), new Float64Array(100), [0.5], 90, DAY, 1);
    expect(late.get(may)).toBeNull();
  });
});

describe('tailFlags', () => {
  // Window: Jan 1..31 with values 1..31, so q01 = 1.3, q10 = 4, q90 = 28, q99 = 30.7 (h = 30p).
  const ts = [...daily(JAN, 31), FEB, FEB + DAY, FEB + 2 * DAY, FEB + 3 * DAY, FEB + 4 * DAY, FEB + 5 * DAY];
  const jan = Array.from({ length: 31 }, (_, i) => i + 1);
  const th = monthlyThresholds(ts, Float64Array.from([...jan, 0, 0, 0, 0, 0, 0]), TAIL_PROBS, 31, DAY, 1);

  it('flags with >= and <= at exact equality', () => {
    const q = th.get(FEB)!;
    expect(q[1]).toBeCloseTo(4, 12);
    expect(q[2]).toBeCloseTo(28, 12);
    const feb = [q[1], q[2], q[0], q[3], 15, Number.NaN];
    const f = tailFlags(ts, Float64Array.from([...jan, ...feb]), th);
    const out = Array.from(f.slice(31));
    expect(out[0]).toBe(TAIL_ELIGIBLE | TAIL_BOTTOM_10);
    expect(out[1]).toBe(TAIL_ELIGIBLE | TAIL_TOP_10);
    expect(out[2]).toBe(TAIL_ELIGIBLE | TAIL_BOTTOM_1 | TAIL_BOTTOM_10);
    expect(out[3]).toBe(TAIL_ELIGIBLE | TAIL_TOP_1 | TAIL_TOP_10);
    expect(out[4]).toBe(TAIL_ELIGIBLE);
    expect(out[5]).toBe(0);
  });

  it('gives all zero flags in a month without thresholds', () => {
    const f = tailFlags(ts, Float64Array.from([...jan, 0, 0, 0, 0, 0, 0]), th);
    expect(Array.from(f.slice(0, 31)).every((x) => x === 0)).toBe(true);
  });

  it('keeps the existing bit values and leaves NaN bars at exactly 0', () => {
    expect([TAIL_TOP_1, TAIL_BOTTOM_1, TAIL_TOP_10, TAIL_BOTTOM_10, TAIL_ELIGIBLE]).toEqual([1, 2, 4, 8, 16]);
    const f = tailFlags(ts, Float64Array.from([...jan, 15, Number.NaN, 15, 15, 15, 15]), th);
    expect(f[31]).toBe(TAIL_ELIGIBLE);
    expect(f[32]).toBe(0);
  });

  it('uses the bar own month thresholds', () => {
    const march = Date.UTC(2023, 2, 1);
    const ts2 = [...daily(JAN, 31), ...daily(FEB, 28), march];
    const vals = Float64Array.from([...jan, ...Array.from({ length: 28 }, (_, i) => 101 + i), 5]);
    const th2 = monthlyThresholds(ts2, vals, TAIL_PROBS, 28, DAY, 1);
    const f = tailFlags(ts2, vals, th2);
    // Feb 1 (101) is far above January's window; March 1 (5) is far below February's window.
    expect(f[31]).toBe(TAIL_ELIGIBLE | TAIL_TOP_1 | TAIL_TOP_10);
    expect(f[ts2.length - 1]).toBe(TAIL_ELIGIBLE | TAIL_BOTTOM_1 | TAIL_BOTTOM_10);
  });
});

describe('atrQuintiles', () => {
  const ts = [...daily(JAN, 31), FEB, FEB + DAY, FEB + 2 * DAY, FEB + 3 * DAY, FEB + 4 * DAY, FEB + 5 * DAY, FEB + 6 * DAY];
  // n = 31 values 1..31, h = 30p: q20 = 7, q40 = 13, q60 = 19, q80 = 25.
  const jan = Array.from({ length: 31 }, (_, i) => i + 1);

  it('bins by <= edges and returns -1 when unavailable', () => {
    const feb = [7, 7.01, 13, 19, 25, 25.01, Number.NaN];
    const q = atrQuintiles(ts, Float64Array.from([...jan, ...feb]), 31, DAY, 1);
    expect(Array.from(q.slice(31))).toEqual([0, 1, 1, 2, 3, 4, -1]);
    expect(Array.from(q.slice(0, 31)).every((x) => x === -1)).toBe(true);
  });

  it('inherits the full-lookback rule (A1-2)', () => {
    const start = Date.UTC(2023, 0, 20);
    const t = daily(start, 200);
    const q = atrQuintiles(t, Float64Array.from(t, (_, i) => 1 + (i % 7)), 90, DAY, 1);
    const may = t.findIndex((x) => x >= Date.UTC(2023, 4, 1));
    expect(Array.from(q.slice(0, may)).every((x) => x === -1)).toBe(true);
    expect(q[may]).toBeGreaterThanOrEqual(0);
  });
});

describe('monthStart', () => {
  it('floors to the UTC month start', () => {
    expect(monthStart(Date.UTC(2023, 1, 17, 5))).toBe(FEB);
  });
});
