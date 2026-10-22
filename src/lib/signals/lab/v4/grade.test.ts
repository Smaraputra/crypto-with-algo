import { describe, expect, it } from 'vitest';

import {
  LAB_HYPOTHESES_V4,
  LAB_V4_HOLD_MS,
  LAB_V4_ROUND_TRIP,
  LAB_V4_THRESHOLD,
  labDelayMs,
} from '@/lib/signals/lab/candidates';
import { initialEState, type EProcessState } from '@/lib/signals/lab/e-process';
import { LAB_GRADE_SETTLE_MS } from '@/lib/signals/lab/job-grade';
import {
  gradeDueAtV4,
  gradeTradeBar,
  priceTimesV4,
  type TradeGradeInput,
} from '@/lib/signals/lab/v4/grade';

describe('lab-v4 pure grading', () => {
  const T = 1_700_000_000_000;

  it('computes gradeDueAtV4 and priceTimesV4 accurately', () => {
    const delay = labDelayMs('1h');
    expect(delay).toBe(600_000);
    expect(LAB_V4_HOLD_MS).toBe(28_800_000);
    expect(LAB_GRADE_SETTLE_MS).toBe(300_000);

    const due = gradeDueAtV4(T);
    expect(due).toBe(T + delay + LAB_V4_HOLD_MS + LAB_GRADE_SETTLE_MS);

    const times = priceTimesV4(T);
    expect(times).toEqual({
      start: T + delay,
      end: T + delay + LAB_V4_HOLD_MS,
    });
  });

  it('grades hand-computed bar with one long and one short coin with funding', () => {
    const scores = { A: 1, B: -1 };
    const prices = {
      A: { start: 100, end: 102 }, // r_A = 0.02
      B: { start: 50, end: 49 },   // r_B = -0.02
    };
    const fundingSums = {
      A: 0.0005,
      B: -0.0002,
    };

    // Long A: 1 * (0.02 - 0.0005) - 0.0014 = 0.0195 - 0.0014 = 0.0181
    // Short B: -1 * (-0.02 - (-0.0002)) - 0.0014 = 0.0198 - 0.0014 = 0.0184
    const rA = 102 / 100 - 1;
    const rB = 49 / 50 - 1;
    const returnA = 1 * (rA - 0.0005) - LAB_V4_ROUND_TRIP;
    const returnB = -1 * (rB - (-0.0002)) - LAB_V4_ROUND_TRIP;
    const expectedR = returnA + returnB;
    const scale = LAB_HYPOTHESES_V4[0].scale!;
    const expectedX = Math.min(expectedR / scale, 1);

    const input: TradeGradeInput = {
      hypothesis: LAB_HYPOTHESES_V4[0],
      barClose: T,
      late: false,
      scores,
      prices,
      fundingSums,
      prev: {
        state: initialEState(),
      },
      gradedAt: new Date(T + 30_000_000),
    };

    const row = gradeTradeBar(input);

    expect(row.version).toBe('lab-v4');
    expect(row.hypothesis).toBe('S1-1h');
    expect(row.barClose).toBe(T);
    expect(row.n).toBe(2);
    expect(row.weights).toEqual({ A: 1, B: -1 });
    expect(row.turnover).toBeNull();
    expect(row.kN).toBeNull();
    expect(row.s).toBeNull();
    expect(row.sHat).toBeNull();
    expect(row.b).toBe(0);
    expect(row.bet).toBe(true);
    expect(row.noBetReason).toBeNull();
    expect(Math.abs(row.netBookReturn! - expectedR)).toBeLessThan(1e-12);
    expect(Math.abs(row.x! - expectedX)).toBeLessThan(1e-12);
    expect(row.prices).toEqual(prices);
    expect(row.funding).toEqual(fundingSums);
  });

  it('leaves an unpriced coin out of R_t while keeping it in weights', () => {
    const scores = { A: 1, B: -1 };
    // B has no valid prices
    const prices = {
      A: { start: 100, end: 102 },
    };
    const fundingSums = {
      A: 0.0005,
    };

    const rA = 102 / 100 - 1;
    const expectedR = 1 * (rA - 0.0005) - LAB_V4_ROUND_TRIP;
    const scale = LAB_HYPOTHESES_V4[0].scale!;
    const expectedX = Math.min(expectedR / scale, 1);

    const input: TradeGradeInput = {
      hypothesis: LAB_HYPOTHESES_V4[0],
      barClose: T,
      late: false,
      scores,
      prices,
      fundingSums,
      prev: {
        state: initialEState(),
      },
      gradedAt: new Date(T + 30_000_000),
    };

    const row = gradeTradeBar(input);

    expect(row.n).toBe(1);
    expect(row.weights).toEqual({ A: 1, B: -1 });
    expect(row.bet).toBe(true);
    expect(row.noBetReason).toBeNull();
    expect(Math.abs(row.netBookReturn! - expectedR)).toBeLessThan(1e-12);
    expect(Math.abs(row.x! - expectedX)).toBeLessThan(1e-12);
    expect(row.prices).toEqual({ A: { start: 100, end: 102 } });
    expect(row.funding).toEqual({ A: 0.0005 });
  });

  it('sets no_position and places no bet when scores has no side coin', () => {
    const input: TradeGradeInput = {
      hypothesis: LAB_HYPOTHESES_V4[0],
      barClose: T,
      late: false,
      scores: { A: 0 },
      prices: {},
      fundingSums: {},
      prev: {
        state: initialEState(),
      },
      gradedAt: new Date(T + 30_000_000),
    };

    const row = gradeTradeBar(input);

    expect(row.n).toBe(0);
    expect(row.weights).toEqual({});
    expect(row.bet).toBe(false);
    expect(row.noBetReason).toBe('no_position');
    expect(row.x).toBeNull();
    expect(row.b).toBeNull();
    expect(row.turnover).toBeNull();
    expect(row.netBookReturn).toBeNull();
    expect(row.lambda).toBe(0);
    expect(row.lambda0).toBe(0);
  });

  it('computes x but places no bet with noBetReason late when late is true', () => {
    const scores = { A: 1 };
    const prices = {
      A: { start: 100, end: 105 },
    };
    const fundingSums = {
      A: 0.0002,
    };

    const rA = 105 / 100 - 1;
    const expectedR = 1 * (rA - 0.0002) - LAB_V4_ROUND_TRIP;
    const scale = LAB_HYPOTHESES_V4[0].scale!;
    const expectedX = Math.min(expectedR / scale, 1);
    const prevState = initialEState();

    const input: TradeGradeInput = {
      hypothesis: LAB_HYPOTHESES_V4[0],
      barClose: T,
      late: true,
      scores,
      prices,
      fundingSums,
      prev: {
        state: prevState,
      },
      gradedAt: new Date(T + 30_000_000),
    };

    const row = gradeTradeBar(input);

    expect(row.bet).toBe(false);
    expect(row.noBetReason).toBe('late');
    expect(row.n).toBe(1);
    expect(row.x).toBeCloseTo(expectedX, 12);
    expect(row.b).toBe(0);
    expect(row.netBookReturn).toBeCloseTo(expectedR, 12);
    expect(row.lambda).toBe(0);
    expect(row.lambda0).toBe(0);
    expect(row.state).toEqual(prevState);
  });

  it('absorbs state on loss larger than 2c while lambda is at the cap and ends betting', () => {
    const warmState: EProcessState = {
      logE: 0.5,
      logE0: 0.5,
      n: 40,
      sumD: 40 * 0.1,
      sumD2: 40 * (0.01 + 0.0001),
      sumX: 40 * 0.1,
      sumX2: 40 * (0.01 + 0.0001),
      crossedAt: null,
    };

    // scale = 0.15. A return of -0.50 gives R_t approx -0.5014, x <= -3 < -2
    const inputAbsorbed: TradeGradeInput = {
      hypothesis: LAB_HYPOTHESES_V4[0],
      barClose: T,
      late: false,
      scores: { A: 1 },
      prices: { A: { start: 100, end: 50 } },
      fundingSums: { A: 0 },
      prev: {
        state: warmState,
      },
      gradedAt: new Date(T + 30_000_000),
    };

    const rowAbsorbed = gradeTradeBar(inputAbsorbed);

    expect(rowAbsorbed.state.absorbed).toBe(true);
    expect(rowAbsorbed.state.logE).toBe(-Infinity);

    const inputLater: TradeGradeInput = {
      hypothesis: LAB_HYPOTHESES_V4[0],
      barClose: T + 3600_000,
      late: false,
      scores: { A: 1 },
      prices: { A: { start: 100, end: 110 } },
      fundingSums: { A: 0 },
      prev: {
        state: rowAbsorbed.state,
      },
      gradedAt: new Date(T + 3600_000 + 30_000_000),
    };

    const rowLater = gradeTradeBar(inputLater);

    expect(rowLater.bet).toBe(false);
    expect(rowLater.noBetReason).toBe('absorbed');
    expect(rowLater.lambda).toBe(0);
    expect(rowLater.lambda0).toBe(0);
    expect(rowLater.state.absorbed).toBe(true);
  });

  it('crosses only when logE reaches log(800) under LAB_V4_THRESHOLD', () => {
    expect(LAB_V4_THRESHOLD).toBe(800);

    // log(400) = 5.99146. If logE is between log(400) and log(800), crossedAt must remain null.
    const sub800State: EProcessState = {
      logE: Math.log(500),
      logE0: Math.log(500),
      n: 40,
      sumD: 40 * 0.1,
      sumD2: 40 * (0.01 + 0.0001),
      sumX: 40 * 0.1,
      sumX2: 40 * (0.01 + 0.0001),
      crossedAt: null,
    };

    const inputSub800: TradeGradeInput = {
      hypothesis: LAB_HYPOTHESES_V4[0],
      barClose: T,
      late: false,
      scores: { A: 1 },
      prices: { A: { start: 100, end: 102 } },
      fundingSums: { A: 0 },
      prev: {
        state: sub800State,
      },
      gradedAt: new Date(T + 30_000_000),
    };

    const rowSub800 = gradeTradeBar(inputSub800);
    expect(rowSub800.state.logE).toBeGreaterThan(Math.log(400));
    expect(rowSub800.state.logE).toBeLessThan(Math.log(800));
    expect(rowSub800.state.crossedAt).toBeNull();

    // Now starting state close enough to log(800) so this winning bar pushes it past log(800)
    const near800State: EProcessState = {
      logE: Math.log(800) - 0.001,
      logE0: Math.log(800) - 0.001,
      n: 40,
      sumD: 40 * 0.1,
      sumD2: 40 * (0.01 + 0.0001),
      sumX: 40 * 0.1,
      sumX2: 40 * (0.01 + 0.0001),
      crossedAt: null,
    };

    const inputCrossing: TradeGradeInput = {
      hypothesis: LAB_HYPOTHESES_V4[0],
      barClose: T,
      late: false,
      scores: { A: 1 },
      prices: { A: { start: 100, end: 102 } },
      fundingSums: { A: 0 },
      prev: {
        state: near800State,
      },
      gradedAt: new Date(T + 30_000_000),
    };

    const rowCrossing = gradeTradeBar(inputCrossing);
    expect(rowCrossing.state.logE).toBeGreaterThanOrEqual(Math.log(800));
    expect(rowCrossing.state.crossedAt).toBe(T);
  });

  it('throws on a priced coin with missing funding', () => {
    const input: TradeGradeInput = {
      hypothesis: LAB_HYPOTHESES_V4[0],
      barClose: T,
      late: false,
      scores: { A: 1 },
      prices: { A: { start: 100, end: 102 } },
      fundingSums: {}, // Missing A
      prev: {
        state: initialEState(),
      },
      gradedAt: new Date(T + 30_000_000),
    };

    expect(() => gradeTradeBar(input)).toThrow(/Missing funding for priced coin: A/);
  });
});
