import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  TF4_LOOKBACKS,
  c3State,
  dailyReturns,
  donchianState,
  ewmaVol,
  isMonthlyDecision,
  isWeeklyDecision,
  meanAbsVol,
  signSum,
  sma,
  stdVol,
  tf1Paths,
  tf2Paths,
  tf3Paths,
  tf4Paths,
  twinOf,
} from './trend-signals';

const SQRT_YEAR = Math.sqrt(365);

/** Closes growing by `r` a day from 100, with day timestamps from 2024-01-01. */
function geometric(n: number, r: number): { t: number[]; c: number[] } {
  const t = Array.from({ length: n }, (_, i) => Date.UTC(2024, 0, 1) + i * DAY_MS);
  const c = Array.from({ length: n }, (_, i) => 100 * (1 + r) ** i);
  return { t, c };
}

describe('return and volatility helpers', () => {
  it('dailyReturns is close over the previous close, NaN at 0', () => {
    const r = dailyReturns([100, 110, 99]);
    expect(r[0]).toBeNaN();
    expect(r[1]).toBeCloseTo(0.1, 12);
    expect(r[2]).toBeCloseTo(-0.1, 12);
  });

  it('signSum adds the sign of each lookback return, 0 until a lookback has history', () => {
    expect(Array.from(signSum([1, 2, 1.5, 3], [1, 2]))).toEqual([0, 1, 0, 2]);
  });

  it('meanAbsVol is the mean absolute return over the window times sqrt(365)', () => {
    const v = meanAbsVol([100, 110, 99, 108.9], 2);
    expect(v[0]).toBeNaN();
    expect(v[1]).toBeNaN();
    expect(v[2]).toBeCloseTo(0.1 * SQRT_YEAR, 10);
    expect(v[3]).toBeCloseTo(0.1 * SQRT_YEAR, 10);
  });

  it('stdVol is the sample standard deviation over the window times sqrt(365)', () => {
    const v = stdVol([100, 110, 99], 2);
    expect(v[1]).toBeNaN();
    expect(v[2]).toBeCloseTo(Math.sqrt(0.02) * SQRT_YEAR, 10);
  });

  it('ewmaVol is an EWMA of squared returns, seeded with their mean square, not demeaned', () => {
    // Returns 0.1, 0.1, 0.2: seed (0.01 + 0.01) / 2, then 2/3 x 0.01 + 1/3 x 0.04 = 0.02.
    const v = ewmaVol([100, 110, 121, 145.2], 2);
    expect(v[1]).toBeNaN();
    expect(v[2]).toBeCloseTo(Math.sqrt(0.01 * 365), 10);
    expect(v[3]).toBeCloseTo(Math.sqrt(0.02 * 365), 10);
    // A constant return has a positive EWMA of squares although its variance is zero.
    const flat = ewmaVol(geometric(10, 0.01).c, 3);
    expect(flat[9]).toBeCloseTo(0.01 * SQRT_YEAR, 10);
  });

  it('sma averages the last n closes including the current one', () => {
    const s = sma([1, 3, 5], 2);
    expect(s[0]).toBeNaN();
    expect(s[1]).toBe(2);
    expect(s[2]).toBe(4);
  });
});

describe('donchianState', () => {
  it('enters at the n-day high, trails the midpoint stop upward and exits at or below it', () => {
    const state = donchianState([10, 11, 12, 11.5, 11.2, 10.9, 13], 3);
    // i=2 enters (stop 11), i=3 raises the stop to 11.5, i=4 closes at 11.2 <= 11.5 and exits, i=6 re-enters.
    expect(Array.from(state)).toEqual([0, 0, 1, 1, 0, 0, 1]);
  });
});

describe('decision schedules', () => {
  it('TF1 decides at the Monday 00:00 close, the end of the Sunday bar', () => {
    expect(isWeeklyDecision(Date.UTC(2024, 0, 7))).toBe(true);
    expect(isWeeklyDecision(Date.UTC(2024, 0, 8))).toBe(false);
  });

  it('TF2 decides at the close on the 1st, the end of the last bar of a month', () => {
    expect(isMonthlyDecision(Date.UTC(2024, 0, 31))).toBe(true);
    expect(isMonthlyDecision(Date.UTC(2024, 0, 30))).toBe(false);
  });
});

describe('rule paths', () => {
  it('TF1 on a steady rise: full score and 0.25 over the mean absolute volatility, weekly', () => {
    const { t, c } = geometric(70, 0.01);
    const p = tf1Paths(t, c);
    expect(p.signal[65]).toBe(1);
    expect(p.size[65]).toBeCloseTo(0.25 / (0.01 * SQRT_YEAR), 10);
    expect(p.signal[10]).toBe(0.25); // only the 7-day lookback has history at i = 10
    expect(p.rebalance).toEqual({ kind: 'on-decision' });
    expect(p.decide(t.indexOf(Date.UTC(2024, 0, 7)))).toBe(true);
  });

  it('TF2 blends the 1, 3 and 12-month signs, a missing horizon counting 0', () => {
    const { t, c } = geometric(400, 0.01);
    const p = tf2Paths(t, c);
    expect(p.signal[100]).toBeCloseTo(2 / 3, 12);
    expect(p.signal[380]).toBe(1);
    expect(p.size[380]).toBeCloseTo(0.4 / (0.01 * SQRT_YEAR), 8);
    expect(p.decide(t.indexOf(Date.UTC(2024, 0, 31)))).toBe(true);
  });

  it('TF3 is long above the 200-day average, flat before it exists, unscaled and traded on a change', () => {
    const { t, c } = geometric(210, 0.001);
    const p = tf3Paths(t, c);
    expect(p.signal[198]).toBe(0);
    expect(p.signal[205]).toBe(1);
    expect(p.size[205]).toBe(1);
    expect(p.rebalance).toEqual({ kind: 'on-signal-change' });
  });

  it('TF4 averages the nine lookbacks: signal k/9, size min(0.25 / sigma90, 2), 20% band', () => {
    const { t, c } = geometric(400, 0.001);
    // Wiggle the returns so sigma90 is positive.
    const wiggled = c.map((x, i) => x * (1 + (i % 2 === 0 ? 0.004 : -0.004)));
    const p = tf4Paths(t, wiggled);
    for (const i of [30, 200, 399]) {
      const k = TF4_LOOKBACKS.reduce((s, n) => s + donchianState(wiggled, n)[i], 0);
      expect(p.signal[i]).toBeCloseTo(k / 9, 12);
    }
    const vol = stdVol(wiggled, 90)[200];
    expect(p.size[200]).toBeCloseTo(Math.min(0.25 / vol, 2), 12);
    expect(p.rebalance).toEqual({ kind: 'band', band: 0.2 });
    // Zero volatility sizes at the cap.
    const steady = tf4Paths(t, c.map(() => 100));
    expect(steady.size[200]).toBe(2);
  });

  it('C3 holds for `hold` days from a top-third rank and re-checks only at the end of a hold', () => {
    const index = [1, 1.01, 1.02, 1.03, 1.1, 1.11, 1.0, 1.01, 1.02];
    expect(Array.from(c3State(index, 1, 3, 2))).toEqual([0, 0, 0, 0, 1, 1, 0, 1, 1]);
  });

  it('the twin keeps size, schedule and rebalance and forces the signal to fully long', () => {
    const { t, c } = geometric(70, -0.01);
    const p = tf1Paths(t, c);
    const twin = twinOf(p);
    expect(p.signal[65]).toBe(-1);
    expect(twin.signal[65]).toBe(1);
    expect(twin.size).toBe(p.size);
    expect(twin.rebalance).toBe(p.rebalance);
  });
});
