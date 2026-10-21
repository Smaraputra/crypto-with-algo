// @vitest-environment node
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FundingSettlement } from '@/lib/models/funding-settlement';
import { LabScore } from '@/lib/models/lab-score';
import { insertLabSignalOnce, LabSignal } from '@/lib/models/lab-signal';
import { LAB_HYPOTHESES_V2, LAB_HYPOTHESES_V3 } from '@/lib/signals/lab/candidates';
import { initialEState, type EProcessState } from '@/lib/signals/lab/e-process';
import {
  defaultFundingSumsFor,
  gradeBar,
  gradeBookBar,
  gradeDueAt,
  LAB_GRADE_SETTLE_MS,
  priceTimes,
  runLabGrade,
  type GradeInput,
  type LabGradeDeps,
} from '@/lib/signals/lab/job-grade';
import { N2 } from '@/lib/signals/lab/v2/n2';
import { N3 } from '@/lib/signals/lab/v2/n3';
import {
  bookReturn,
  kN,
  kNNoTies,
  populationSd,
  rankWeightedCorrelation,
} from '@/lib/stats/rank-ic';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

describe('pure lab grading', () => {
  const symbols = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'];
  const T = 1_700_000_000_000;

  function makeScores(): Record<string, number> {
    const scores: Record<string, number> = {};
    for (let i = 0; i < symbols.length; i++) {
      scores[symbols[i]] = i;
    }
    return scores;
  }

  function makePrices(returns: number[]): Record<string, { start: number; end: number }> {
    const prices: Record<string, { start: number; end: number }> = {};
    for (let i = 0; i < returns.length; i++) {
      const sym = symbols[i];
      const start = 100;
      const end = 100 * (1 + returns[i]);
      prices[sym] = { start, end };
    }
    return prices;
  }

  it('computes gradeDueAt and priceTimes accurately', () => {
    const dueAt8h = gradeDueAt(T, '8h');
    expect(dueAt8h).toBe(T + 600_000 + 28_800_000 + 300_000);
    expect(LAB_GRADE_SETTLE_MS).toBe(300_000);

    const times5m = priceTimes(T, '5m');
    expect(times5m).toEqual({ start: T + 300_000, end: T + 600_000 });
  });

  it('grades standard bar with 10 priced coins during warm-up', () => {
    const scores = makeScores();
    const returns = symbols.map((_, i) => 0.001 * i);
    const prices = makePrices(returns);

    const prev = {
      state: initialEState(),
      weights: null,
      pastS: [0.01],
    };

    const input: GradeInput = {
      hypothesis: 'L1-8h',
      barClose: T,
      late: false,
      scores,
      prices,
      prev,
      gradedAt: new Date(T + 30_000_000),
    };

    const row = gradeBar(input);

    const pricedScores = symbols.map((sym) => scores[sym]);
    const pricedReturns = symbols.map((sym) => prices[sym].end / prices[sym].start - 1);
    const expectedX = rankWeightedCorrelation(pricedScores, pricedReturns);
    const expectedKn = kNNoTies(10);
    const expectedB = 0.0007 / (expectedKn * 0.01);
    const expectedNetReturn = bookReturn(pricedScores, pricedReturns) - 0.0007;

    expect(row.x).toBeCloseTo(expectedX, 12);
    expect(row.turnover).toBe(1);
    expect(row.kN).toBeCloseTo(expectedKn, 12);
    expect(row.b).toBeCloseTo(expectedB, 12);
    expect(row.bet).toBe(true);
    expect(row.lambda).toBe(0);
    expect(row.netBookReturn).toBeCloseTo(expectedNetReturn, 12);
    expect(row.noBetReason).toBeNull();
  });

  it('satisfies identity bookReturn === kN * s * x when all scored coins are priced', () => {
    const scores = makeScores();
    const returns = [0.002, -0.004, 0.001, 0.005, -0.003, 0.008, -0.001, 0.006, -0.005, 0.003];
    const prices = makePrices(returns);

    const input: GradeInput = {
      hypothesis: 'L1-8h',
      barClose: T,
      late: false,
      scores,
      prices,
      prev: {
        state: initialEState(),
        weights: null,
        pastS: [0.01],
      },
      gradedAt: new Date(T + 30_000_000),
    };

    const row = gradeBar(input);
    const pricedScores = symbols.map((sym) => scores[sym]);
    const pricedReturns = symbols.map((sym) => prices[sym].end / prices[sym].start - 1);
    const br = bookReturn(pricedScores, pricedReturns);

    expect(Math.abs(br - row.kN! * row.s! * row.x!)).toBeLessThan(1e-12);
  });

  it('places no bet when fewer than 8 coins are priced', () => {
    const scores = makeScores();
    // Only 7 priced coins (S0 to S6)
    const returns = [0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007];
    const prices = makePrices(returns);

    const prevState = initialEState();
    const input: GradeInput = {
      hypothesis: 'L1-8h',
      barClose: T,
      late: false,
      scores,
      prices,
      prev: {
        state: prevState,
        weights: { S0: 0.5, S1: -0.5 },
        pastS: [0.01],
      },
      gradedAt: new Date(T + 30_000_000),
    };

    const row = gradeBar(input);

    expect(row.n).toBe(7);
    expect(row.noBetReason).toBe('cross_section');
    expect(row.bet).toBe(false);
    expect(row.x).toBeNull();
    expect(row.b).toBeNull();
    expect(row.turnover).toBeNull();
    expect(row.kN).toBeNull();
    expect(row.s).toBeNull();
    expect(row.sHat).toBeNull();
    expect(row.weights).toBeNull();
    expect(row.netBookReturn).toBeNull();
    expect(row.lambda).toBe(0);
    expect(row.lambda0).toBe(0);
    expect(row.state).toEqual(prevState);
    expect(Object.keys(row.prices)).toHaveLength(7);
  });

  it('keeps book known at T when one scored coin lacks prices and 9 are priced', () => {
    const scores = makeScores();
    // 9 priced coins (S0 to S8) with non-collinear returns to avoid float rounding exceeding 1
    const returns = [0.001, 0.003, 0.002, 0.004, 0.005, 0.007, 0.006, 0.008, 0.009];
    const prices = makePrices(returns);

    const input: GradeInput = {
      hypothesis: 'L1-8h',
      barClose: T,
      late: false,
      scores,
      prices,
      prev: {
        state: initialEState(),
        weights: null,
        pastS: [0.01],
      },
      gradedAt: new Date(T + 30_000_000),
    };

    const row = gradeBar(input);

    expect(row.n).toBe(9);
    expect(Object.keys(row.weights!)).toHaveLength(10);
    expect(row.kN).toBeCloseTo(kNNoTies(10), 12);

    const pricedSymbols = symbols.slice(0, 9);
    const pricedScores = pricedSymbols.map((sym) => scores[sym]);
    const pricedReturns = pricedSymbols.map((sym) => prices[sym].end / prices[sym].start - 1);

    expect(row.x).toBeCloseTo(rankWeightedCorrelation(pricedScores, pricedReturns), 12);
    expect(row.s).toBeCloseTo(populationSd(pricedReturns), 12);
  });

  it('stores weights and s when late is true while state remains unchanged', () => {
    const scores = makeScores();
    const returns = symbols.map((_, i) => 0.001 * (i + 1));
    const prices = makePrices(returns);

    const prevState = initialEState();
    const input: GradeInput = {
      hypothesis: 'L1-8h',
      barClose: T,
      late: true,
      scores,
      prices,
      prev: {
        state: prevState,
        weights: null,
        pastS: [0.01],
      },
      gradedAt: new Date(T + 30_000_000),
    };

    const row = gradeBar(input);

    expect(row.noBetReason).toBe('late');
    expect(row.bet).toBe(false);
    expect(row.lambda).toBe(0);
    expect(row.lambda0).toBe(0);
    expect(row.state).toEqual(prevState);
    expect(row.weights).not.toBeNull();
    expect(row.s).not.toBeNull();
  });

  it('marks degenerate and sets x to null when all coins have equal returns', () => {
    const scores = makeScores();
    const returns = new Array(10).fill(0.002);
    const prices = makePrices(returns);

    const input: GradeInput = {
      hypothesis: 'L1-8h',
      barClose: T,
      late: false,
      scores,
      prices,
      prev: {
        state: initialEState(),
        weights: null,
        pastS: [0.01],
      },
      gradedAt: new Date(T + 30_000_000),
    };

    const row = gradeBar(input);

    expect(row.noBetReason).toBe('degenerate');
    expect(row.x).toBeNull();
    expect(row.bet).toBe(false);
    expect(row.lambda).toBe(0);
  });

  it('marks no_hurdle when pastS is empty', () => {
    const scores = makeScores();
    const returns = symbols.map((_, i) => 0.001 * (i + 1));
    const prices = makePrices(returns);

    const input: GradeInput = {
      hypothesis: 'L1-8h',
      barClose: T,
      late: false,
      scores,
      prices,
      prev: {
        state: initialEState(),
        weights: null,
        pastS: [],
      },
      gradedAt: new Date(T + 30_000_000),
    };

    const row = gradeBar(input);

    expect(row.sHat).toBeNull();
    expect(row.b).toBeNull();
    expect(row.noBetReason).toBe('no_hurdle');
    expect(row.bet).toBe(false);
  });

  it('ensures predictability by producing identical hurdle components regardless of prices', () => {
    const scores = makeScores();
    const prevWeights: Record<string, number> = {};
    for (let i = 0; i < symbols.length; i++) {
      prevWeights[symbols[i]] = (i - 4.5) / 10;
    }
    const prev = {
      state: initialEState(),
      weights: prevWeights,
      pastS: [0.015, 0.02],
    };

    const prices1 = makePrices(symbols.map((_, i) => 0.001 * i));
    const prices2 = makePrices(symbols.map((_, i) => -0.002 * (i + 1)));

    const row1 = gradeBar({
      hypothesis: 'L1-8h',
      barClose: T,
      late: false,
      scores,
      prices: prices1,
      prev,
      gradedAt: new Date(T + 30_000_000),
    });

    const row2 = gradeBar({
      hypothesis: 'L1-8h',
      barClose: T,
      late: false,
      scores,
      prices: prices2,
      prev,
      gradedAt: new Date(T + 30_000_000),
    });

    expect(row1.x).not.toBe(row2.x);
    expect(row1.weights).toEqual(row2.weights);
    expect(row1.turnover).toBe(row2.turnover);
    expect(row1.kN).toBe(row2.kN);
    expect(row1.sHat).toBe(row2.sHat);
    expect(row1.b).toBe(row2.b);
  });

  it('updates state accurately for a warm state with positive lambda', () => {
    const scores = makeScores();
    const returns = symbols.map((_, i) => 0.001 * i);
    const prices = makePrices(returns);

    const prevWarm = {
      state: {
        logE: 0.5,
        logE0: 0.5,
        n: 40,
        sumD: 40 * 0.05,
        sumD2: 40 * (0.05 * 0.05 + 0.001),
        sumX: 40 * 0.06,
        sumX2: 40 * (0.06 * 0.06 + 0.001),
        crossedAt: null,
      },
      weights: null,
      pastS: [0.01],
    };

    const input: GradeInput = {
      hypothesis: 'L1-8h',
      barClose: T,
      late: false,
      scores,
      prices,
      prev: prevWarm,
      gradedAt: new Date(T + 30_000_000),
    };

    const row = gradeBar(input);

    expect(row.bet).toBe(true);
    expect(row.lambda).toBeGreaterThan(0);
    const expectedLogE = prevWarm.state.logE + Math.log1p(row.lambda * (row.x! - row.b!));
    expect(Math.abs(row.state.logE - expectedLogE)).toBeLessThan(1e-12);
  });

  it('enforces precedence: cross_section beats late, late beats degenerate, degenerate beats no_hurdle', () => {
    const scores = makeScores();
    const degenerateReturns = new Array(10).fill(0.002);
    const degeneratePrices = makePrices(degenerateReturns);

    // One input that is both late and degenerate gives 'late'
    const lateAndDegenRow = gradeBar({
      hypothesis: 'L1-8h',
      barClose: T,
      late: true,
      scores,
      prices: degeneratePrices,
      prev: {
        state: initialEState(),
        weights: null,
        pastS: [0.01],
      },
      gradedAt: new Date(T + 30_000_000),
    });
    expect(lateAndDegenRow.noBetReason).toBe('late');
    expect(lateAndDegenRow.bet).toBe(false);

    // Degenerate with no hurdle (pastS: []) gives 'degenerate'
    const degenAndNoHurdleRow = gradeBar({
      hypothesis: 'L1-8h',
      barClose: T,
      late: false,
      scores,
      prices: degeneratePrices,
      prev: {
        state: initialEState(),
        weights: null,
        pastS: [],
      },
      gradedAt: new Date(T + 30_000_000),
    });
    expect(degenAndNoHurdleRow.noBetReason).toBe('degenerate');
    expect(degenAndNoHurdleRow.bet).toBe(false);

    // Seven priced coins and late: true gives 'cross_section'
    const sevenReturns = [0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007];
    const sevenPrices = makePrices(sevenReturns);
    const crossSectionAndLateRow = gradeBar({
      hypothesis: 'L1-8h',
      barClose: T,
      late: true,
      scores,
      prices: sevenPrices,
      prev: {
        state: initialEState(),
        weights: null,
        pastS: [0.01],
      },
      gradedAt: new Date(T + 30_000_000),
    });
    expect(crossSectionAndLateRow.noBetReason).toBe('cross_section');
    expect(crossSectionAndLateRow.bet).toBe(false);
  });

  it('excludes non-finite score from weights and kN, and invalid prices from prices and n', () => {
    const scores = makeScores();
    scores['S9'] = NaN;

    const returns9 = symbols.slice(0, 9).map((_, i) => 0.001 * (i + 1));
    const prices9: Record<string, { start: number; end: number }> = {};
    for (let i = 0; i < 9; i++) {
      prices9[symbols[i]] = { start: 100, end: 100 * (1 + returns9[i]) };
    }

    const row = gradeBar({
      hypothesis: 'L1-8h',
      barClose: T,
      late: false,
      scores,
      prices: prices9,
      prev: {
        state: initialEState(),
        weights: null,
        pastS: [0.01],
      },
      gradedAt: new Date(T + 30_000_000),
    });

    expect(row.weights).not.toBeNull();
    expect('S9' in row.weights!).toBe(false);
    expect(Object.keys(row.weights!)).toHaveLength(9);

    const otherNineScores = symbols.slice(0, 9).map((sym) => scores[sym]);
    expect(row.kN).toBeCloseTo(kN(otherNineScores), 12);

    const symbols11 = [...symbols, 'S10'];
    const scores11: Record<string, number> = {};
    for (let i = 0; i < symbols11.length; i++) {
      scores11[symbols11[i]] = i;
    }
    const prices11: Record<string, { start: number; end: number }> = {
      S0: { start: 0, end: 100 },
      S1: { start: 100, end: NaN },
      S2: { start: -1, end: 100 },
    };
    for (let i = 3; i < symbols11.length; i++) {
      prices11[symbols11[i]] = { start: 100, end: 100 * (1 + 0.001 * i) };
    }

    const rowInvalidPrices = gradeBar({
      hypothesis: 'L1-8h',
      barClose: T,
      late: false,
      scores: scores11,
      prices: prices11,
      prev: {
        state: initialEState(),
        weights: null,
        pastS: [0.01],
      },
      gradedAt: new Date(T + 30_000_000),
    });

    expect(rowInvalidPrices.n).toBe(8);
    expect('S0' in rowInvalidPrices.prices).toBe(false);
    expect('S1' in rowInvalidPrices.prices).toBe(false);
    expect('S2' in rowInvalidPrices.prices).toBe(false);
    expect(Object.keys(rowInvalidPrices.prices)).toHaveLength(8);
  });

  it('hardens stepEProcess rejection invariant on perfectly linear bar', () => {
    const scores = makeScores();
    const returns = symbols.map((_, i) => 0.001 * (i + 1));
    const prices = makePrices(returns);

    const row = gradeBar({
      hypothesis: 'L1-8h',
      barClose: T,
      late: false,
      scores,
      prices,
      prev: {
        state: initialEState(),
        weights: null,
        pastS: [0.01],
      },
      gradedAt: new Date(T + 30_000_000),
    });

    // Directly assert invariant: row.bet === (row.noBetReason === null)
    expect(row.bet).toBe(row.noBetReason === null);

    if (row.bet) {
      expect(Math.abs(row.x!)).toBeLessThanOrEqual(1);
      expect(row.noBetReason).toBeNull();
    } else {
      expect(row.noBetReason).toBe('degenerate');
      expect(row.x).toBeNull();
    }
  });
});

describe('pure lab-v2 gradeBookBar', () => {
  const T = 1_700_000_000_000;

  it('grades N2 hand-computed bar with funding and turnover', () => {
    const weights = { A: 0.5, B: -0.5 };
    const wPrev = { A: 0.25, C: -0.25 };
    const prices = {
      A: { start: 100, end: 102 },
      B: { start: 100, end: 99 },
    };
    const fundingSums = { A: 0.001, B: -0.002 };

    const expectedR =
      0.5 * (0.02 - 0.001) -
      0.5 * (-0.01 + 0.002) -
      0.0007 * (0.25 + 0.5 + 0.25);
    const expectedX = Math.min(expectedR / 0.13, 1);

    const row = gradeBookBar({
      hypothesis: LAB_HYPOTHESES_V2[0],
      barClose: T,
      late: false,
      scores: weights,
      prices,
      fundingSums,
      prev: {
        state: initialEState(),
        weights: wPrev,
      },
      gradedAt: new Date(T + 60_000),
    });

    expect(Math.abs(row.netBookReturn! - expectedR)).toBeLessThan(1e-12);
    expect(Math.abs(row.x! - expectedX)).toBeLessThan(1e-12);
    expect(row.b).toBe(0);
    expect(row.bet).toBe(true);
    expect(row.noBetReason).toBeNull();
    expect(row.weights).toEqual(weights);
    expect(row.funding).toEqual({ A: 0.001, B: -0.002 });
  });

  it('grades F1 hand-computed bar with funding, turnover, and threshold 200', () => {
    const weights = { BTCUSDT: 0.5, ETHUSDT: -0.5 };
    const wPrev = { BTCUSDT: 0.25, SOLUSDT: -0.25 };
    const prices = {
      BTCUSDT: { start: 100, end: 102 },
      ETHUSDT: { start: 100, end: 99 },
    };
    const fundingSums = { BTCUSDT: 0.001, ETHUSDT: -0.002 };

    const turnover = 0.25 + 0.5 + 0.25;
    const expectedR =
      0.5 * (0.02 - 0.001) -
      0.5 * (-0.01 + 0.002) -
      0.0007 * turnover;
    const scale = 0.1;
    const expectedX = Math.min(expectedR / scale, 1);

    const row = gradeBookBar({
      hypothesis: LAB_HYPOTHESES_V3[0],
      barClose: T,
      late: false,
      scores: weights,
      prices,
      fundingSums,
      prev: {
        state: initialEState(),
        weights: wPrev,
      },
      gradedAt: new Date(T + 60_000),
    });

    expect(row.version).toBe('lab-v3');
    expect(row.hypothesis).toBe('F1-1d');
    expect(Math.abs(row.netBookReturn! - expectedR)).toBeLessThan(1e-12);
    expect(Math.abs(row.x! - expectedX)).toBeLessThan(1e-12);
    expect(row.b).toBe(0);
    expect(row.bet).toBe(true);
    expect(row.noBetReason).toBeNull();
    expect(row.weights).toEqual(weights);
  });

  it('grades a cash week with R = -0.0007 * turnover', () => {
    const wPrev = { A: 0.3, B: -0.4, C: 0.1 };
    const turnover = 0.3 + 0.4 + 0.1;
    const expectedR = -0.0007 * turnover;

    const row = gradeBookBar({
      hypothesis: LAB_HYPOTHESES_V2[0],
      barClose: T,
      late: false,
      scores: {},
      prices: {},
      fundingSums: {},
      prev: {
        state: initialEState(),
        weights: wPrev,
      },
      gradedAt: new Date(T + 60_000),
    });

    expect(row.bet).toBe(true);
    expect(row.noBetReason).toBeNull();
    expect(row.turnover).toBeCloseTo(turnover, 12);
    expect(row.netBookReturn).toBeCloseTo(expectedR, 12);
    expect(row.x).toBeCloseTo(expectedR / 0.13, 12);
    expect(row.b).toBe(0);
    expect(row.weights).toEqual({});
    expect(row.n).toBe(0);
  });

  it('grades N3 hand-computed bar with two longs and a short with funding', () => {
    const scores = { A: 1, B: 1, C: -1 };
    const prices = {
      A: { start: 100, end: 102 },
      B: { start: 200, end: 204 },
      C: { start: 50, end: 49 },
    };
    const fundingSums = {
      A: 0.0005,
      B: -0.0003,
      C: 0.0002,
    };

    const expectedR =
      (1 * (0.02 - 0.0005) - 0.0014) +
      (1 * (0.02 + 0.0003) - 0.0014) +
      (-1 * (-0.02 - 0.0002) - 0.0014);
    const expectedX = Math.min(expectedR / 0.8, 1);

    const row = gradeBookBar({
      hypothesis: LAB_HYPOTHESES_V2[1],
      barClose: T,
      late: false,
      scores,
      prices,
      fundingSums,
      prev: {
        state: initialEState(),
        weights: null,
      },
      gradedAt: new Date(T + 60_000),
    });

    expect(Math.abs(row.netBookReturn! - expectedR)).toBeLessThan(1e-12);
    expect(Math.abs(row.x! - expectedX)).toBeLessThan(1e-12);
    expect(row.b).toBe(0);
    expect(row.bet).toBe(true);
    expect(row.noBetReason).toBeNull();
    expect(row.weights).toEqual(scores);
    expect(row.funding).toEqual(fundingSums);
    expect(row.n).toBe(3);
  });

  it('sets no_position and places no bet when scores has no side', () => {
    const row = gradeBookBar({
      hypothesis: LAB_HYPOTHESES_V2[1],
      barClose: T,
      late: false,
      scores: {},
      prices: {},
      fundingSums: {},
      prev: {
        state: initialEState(),
        weights: null,
      },
      gradedAt: new Date(T + 60_000),
    });

    expect(row.noBetReason).toBe('no_position');
    expect(row.bet).toBe(false);
    expect(row.x).toBeNull();
    expect(row.b).toBeNull();
    expect(row.netBookReturn).toBeNull();
    expect(row.lambda).toBe(0);
    expect(row.lambda0).toBe(0);
  });

  it('absorbs state on loss larger than 2 x scale with lambda at cap and later bars do not bet', () => {
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

    const rowAbsorbed = gradeBookBar({
      hypothesis: LAB_HYPOTHESES_V2[0],
      barClose: T,
      late: false,
      scores: { A: 1 },
      prices: { A: { start: 100, end: 70 } },
      fundingSums: { A: 0 },
      prev: {
        state: warmState,
        weights: { A: 1 },
      },
      gradedAt: new Date(T + 60_000),
    });

    expect(rowAbsorbed.state.absorbed).toBe(true);
    expect(rowAbsorbed.state.logE).toBe(-Infinity);

    const rowLater = gradeBookBar({
      hypothesis: LAB_HYPOTHESES_V2[0],
      barClose: T + 86_400_000,
      late: false,
      scores: { A: 1 },
      prices: { A: { start: 100, end: 110 } },
      fundingSums: { A: 0 },
      prev: {
        state: rowAbsorbed.state,
        weights: rowAbsorbed.weights,
      },
      gradedAt: new Date(T + 86_400_000 + 60_000),
    });

    expect(rowLater.bet).toBe(false);
    expect(rowLater.lambda).toBe(0);
    expect(rowLater.lambda0).toBe(0);
    expect(rowLater.state.absorbed).toBe(true);
  });

  it('uses threshold 400 to set crossedAt when crossing log 400 but not log 800', () => {
    const warmState: EProcessState = {
      logE: 5.98,
      logE0: 5.98,
      n: 40,
      sumD: 40 * 0.1,
      sumD2: 40 * (0.01 + 0.0001),
      sumX: 40 * 0.1,
      sumX2: 40 * (0.01 + 0.0001),
      crossedAt: null,
    };

    const row = gradeBookBar({
      hypothesis: LAB_HYPOTHESES_V2[0],
      barClose: T,
      late: false,
      scores: { A: 1 },
      prices: { A: { start: 100, end: 105 } },
      fundingSums: { A: 0 },
      prev: {
        state: warmState,
        weights: { A: 1 },
      },
      gradedAt: new Date(T + 60_000),
    });

    expect(row.state.logE).toBeGreaterThan(Math.log(400));
    expect(row.state.logE).toBeLessThan(Math.log(800));
    expect(row.state.crossedAt).toBe(T);
  });

  it('computes R using imported N2.costRate constant and asserts that changing it changes R', () => {
    const weights = { A: 0.6, B: -0.4 };
    const wPrev = { A: 0.2, B: 0.2 };
    const prices = {
      A: { start: 100, end: 105 },
      B: { start: 50, end: 45 },
    };
    const fundingSums = { A: 0.001, B: -0.001 };

    const turnover = Math.abs(0.6 - 0.2) + Math.abs(-0.4 - 0.2); // 0.4 + 0.6 = 1.0
    const sumReturnFunding =
      0.6 * (0.05 - 0.001) +
      (-0.4) * (-0.1 + 0.001);
    const expectedR = sumReturnFunding - N2.costRate * turnover;

    const row = gradeBookBar({
      hypothesis: LAB_HYPOTHESES_V2[0],
      barClose: T,
      late: false,
      scores: weights,
      prices,
      fundingSums,
      prev: {
        state: initialEState(),
        weights: wPrev,
      },
      gradedAt: new Date(T + 60_000),
    });

    expect(row.netBookReturn).toBeCloseTo(expectedR, 12);
    // Changing N2.costRate (e.g. if costRate were 0 or 2 * N2.costRate) would change R
    expect(row.netBookReturn).not.toBeCloseTo(sumReturnFunding, 6);
    expect(row.netBookReturn).not.toBeCloseTo(sumReturnFunding - 2 * N2.costRate * turnover, 6);
  });

  it('throws when hypothesis is missing scale or has invalid scale or invalid candidate', () => {
    const validHyp = LAB_HYPOTHESES_V2[0];
    const hypWithoutScale = {
      id: validHyp.id,
      candidate: validHyp.candidate,
      timeframe: validHyp.timeframe,
      version: validHyp.version,
    };

    expect(() =>
      gradeBookBar({
        hypothesis: hypWithoutScale,
        barClose: T,
        late: false,
        scores: { A: 1 },
        prices: { A: { start: 100, end: 105 } },
        fundingSums: { A: 0 },
        prev: {
          state: initialEState(),
          weights: null,
        },
        gradedAt: new Date(T + 60_000),
      })
    ).toThrow(/scale/);

    expect(() =>
      gradeBookBar({
        hypothesis: { ...validHyp, scale: 0 },
        barClose: T,
        late: false,
        scores: { A: 1 },
        prices: { A: { start: 100, end: 105 } },
        fundingSums: { A: 0 },
        prev: {
          state: initialEState(),
          weights: null,
        },
        gradedAt: new Date(T + 60_000),
      })
    ).toThrow(/scale/);

    expect(() =>
      gradeBookBar({
        hypothesis: { ...validHyp, scale: -0.1 },
        barClose: T,
        late: false,
        scores: { A: 1 },
        prices: { A: { start: 100, end: 105 } },
        fundingSums: { A: 0 },
        prev: {
          state: initialEState(),
          weights: null,
        },
        gradedAt: new Date(T + 60_000),
      })
    ).toThrow(/scale/);

    expect(() =>
      gradeBookBar({
        hypothesis: { ...validHyp, candidate: 'INVALID' as unknown as 'N2' },
        barClose: T,
        late: false,
        scores: { A: 1 },
        prices: { A: { start: 100, end: 105 } },
        fundingSums: { A: 0 },
        prev: {
          state: initialEState(),
          weights: null,
        },
        gradedAt: new Date(T + 60_000),
      })
    ).toThrow(/candidate/);
  });

  it('gives noBetReason: absorbed when incoming state is already absorbed', () => {
    const absorbedState: EProcessState = {
      logE: -Infinity,
      logE0: 0.1,
      n: 40,
      sumD: 2,
      sumD2: 0.5,
      sumX: 2,
      sumX2: 0.5,
      crossedAt: null,
      absorbed: true,
    };

    const row = gradeBookBar({
      hypothesis: LAB_HYPOTHESES_V2[0],
      barClose: T,
      late: false,
      scores: { A: 1 },
      prices: { A: { start: 100, end: 105 } },
      fundingSums: { A: 0 },
      prev: {
        state: absorbedState,
        weights: { A: 1 },
      },
      gradedAt: new Date(T + 60_000),
    });

    expect(row.bet).toBe(false);
    expect(row.noBetReason).toBe('absorbed');
    expect(row.state.absorbed).toBe(true);
    expect(row.lambda).toBe(0);
    expect(row.lambda0).toBe(0);
  });
});

describe('runLabGrade with mocked deps for v1 and v2', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await LabSignal.init();
    await LabScore.init();
  }, 30_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  afterEach(async () => {
    await LabSignal.deleteMany({});
    await LabScore.deleteMany({});
  });

  it('grades lab-v1 rows exactly as before and grades lab-v2 N3 row through gradeBookBar', async () => {
    const T1 = Date.UTC(2026, 9, 18, 0);

    const v1Symbols = [
      'BTCUSDT',
      'ETHUSDT',
      'SOLUSDT',
      'BNBUSDT',
      'XRPUSDT',
      'DOGEUSDT',
      'ADAUSDT',
      'AVAXUSDT',
      'LINKUSDT',
      'DOTUSDT',
    ];
    const v1Scores: Record<string, number> = {};
    for (let i = 0; i < v1Symbols.length; i++) {
      v1Scores[v1Symbols[i]] = i;
    }

    await insertLabSignalOnce({
      version: 'lab-v1',
      hypothesis: 'L1-8h',
      candidate: 'L1',
      timeframe: '8h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: v1Scores,
      skipped: [],
      inputs: {},
    });

    await insertLabSignalOnce({
      version: 'lab-v2',
      hypothesis: 'N3-1d',
      candidate: 'N3',
      timeframe: '1d',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1, ETHUSDT: -1 },
      skipped: [],
      inputs: {},
    });

    const now = Math.max(gradeDueAt(T1, '8h'), gradeDueAt(T1, '1d')) + 1000;

    const mockFetchPerpKlinesRange = vi.fn().mockImplementation(
      async (symbol: string, _interval: string, startTime: number, endTime: number) => {
        const klines = [];
        for (let t = startTime; t <= endTime; t += 300_000) {
          let open = 100;
          if (symbol === 'BTCUSDT') {
            open = t === startTime ? 100 : 102;
          } else if (symbol === 'ETHUSDT') {
            open = t === startTime ? 200 : 196;
          } else {
            const idx = v1Symbols.indexOf(symbol);
            open = 100 + (t === startTime ? 0 : (idx + 1) * 0.1);
          }
          klines.push({
            openTime: t,
            closeTime: t + 300_000 - 1,
            open,
            high: open * 1.01,
            low: open * 0.99,
            close: open,
            volume: 1000,
            quoteVolume: 100_000,
            trades: 50,
            takerBuyVolume: 500,
          });
        }
        return klines;
      }
    );

    const mockFundingSumsFor = vi.fn().mockResolvedValue({
      BTCUSDT: 0.0005,
      ETHUSDT: -0.0002,
    });

    const deps: LabGradeDeps = {
      fetchPerpKlinesRange: mockFetchPerpKlinesRange,
      fundingSumsFor: mockFundingSumsFor,
      clock: () => now,
    };

    const report = await runLabGrade(now, deps);

    expect(report.success).toBe(true);
    expect(report.graded).toHaveLength(2);

    const v1Row = await LabScore.findOne({ hypothesis: 'L1-8h', barClose: T1 }).lean();
    expect(v1Row).not.toBeNull();
    expect(v1Row!.version).toBe('lab-v1');
    expect(v1Row!.hypothesis).toBe('L1-8h');
    expect(v1Row!.noBetReason).toBe('no_hurdle');
    expect(v1Row!.bet).toBe(false);
    expect(v1Row!.funding).toBeNull();

    const v2Row = await LabScore.findOne({ hypothesis: 'N3-1d', barClose: T1 }).lean();
    expect(v2Row).not.toBeNull();
    expect(v2Row!.version).toBe('lab-v2');
    expect(v2Row!.hypothesis).toBe('N3-1d');
    expect(v2Row!.b).toBe(0);
    expect(v2Row!.bet).toBe(true);
    expect(v2Row!.noBetReason).toBeNull();
    expect(v2Row!.turnover).toBeNull();
    expect(v2Row!.weights).toEqual({ BTCUSDT: 1, ETHUSDT: -1 });
    expect(v2Row!.funding).toEqual({ BTCUSDT: 0.0005, ETHUSDT: -0.0002 });

    const expectedR_N3 =
      (1 * (0.02 - 0.0005) - N3.costPerTrade) +
      (-1 * (-0.02 + 0.0002) - N3.costPerTrade);
    expect(v2Row!.netBookReturn).toBeCloseTo(expectedR_N3, 12);
    expect(v2Row!.x).toBeCloseTo(expectedR_N3 / 0.8, 12);
  });

  it('leaves bar ungraded with no row written on funding sync error, and grades it once sync succeeds', async () => {
    const T1 = Date.UTC(2026, 9, 18, 0);

    await insertLabSignalOnce({
      version: 'lab-v2',
      hypothesis: 'N3-1d',
      candidate: 'N3',
      timeframe: '1d',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    const now = gradeDueAt(T1, '1d') + 1000;
    const { start, end } = priceTimes(T1, '1d');

    const mockFetchPerpKlinesRange = vi.fn().mockResolvedValue([
      {
        openTime: start,
        closeTime: start + 300_000 - 1,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1000,
        quoteVolume: 100_000,
        trades: 50,
        takerBuyVolume: 500,
      },
      {
        openTime: end,
        closeTime: end + 300_000 - 1,
        open: 102,
        high: 103,
        low: 101,
        close: 102,
        volume: 1000,
        quoteVolume: 100_000,
        trades: 50,
        takerBuyVolume: 500,
      },
    ]);

    const mockSyncFundingSettlements = vi.fn();
    const mockFundingSumsFor = vi.fn().mockResolvedValue({
      sums: { BTCUSDT: 0.0005 },
      coverage: { BTCUSDT: true },
    });

    // Run 1: syncFundingSettlements reports an error for BTCUSDT
    mockSyncFundingSettlements.mockResolvedValueOnce([
      { symbol: 'BTCUSDT', inserted: 0, updated: 0, error: 'connection reset by peer' },
    ]);

    const deps1: LabGradeDeps = {
      fetchPerpKlinesRange: mockFetchPerpKlinesRange,
      syncFundingSettlements: mockSyncFundingSettlements,
      fundingSumsFor: mockFundingSumsFor,
      clock: () => now,
    };

    const report1 = await runLabGrade(now, deps1);

    expect(report1.graded).toHaveLength(0);
    expect(report1.pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hypothesis: 'N3-1d', barClose: T1 }),
      ])
    );
    const rowAfterRun1 = await LabScore.findOne({ hypothesis: 'N3-1d', barClose: T1 }).lean();
    expect(rowAfterRun1).toBeNull();

    // Run 2: syncFundingSettlements succeeds
    mockSyncFundingSettlements.mockResolvedValueOnce([
      { symbol: 'BTCUSDT', inserted: 3, updated: 0 },
    ]);

    const report2 = await runLabGrade(now + 3600_000, {
      ...deps1,
      clock: () => now + 3600_000,
    });

    expect(report2.graded).toHaveLength(1);
    expect(report2.graded[0].hypothesis).toBe('N3-1d');
    const rowAfterRun2 = await LabScore.findOne({ hypothesis: 'N3-1d', barClose: T1 }).lean();
    expect(rowAfterRun2).not.toBeNull();
    expect(rowAfterRun2!.version).toBe('lab-v2');
    expect(rowAfterRun2!.hypothesis).toBe('N3-1d');
    expect(rowAfterRun2!.bet).toBe(true);
  });

  it('leaves bar ungraded when settlement coverage is missing, and reports coverage gap older than 48 hours', async () => {
    const T1 = Date.UTC(2026, 9, 18, 0);

    await insertLabSignalOnce({
      version: 'lab-v2',
      hypothesis: 'N3-1d',
      candidate: 'N3',
      timeframe: '1d',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    const { start, end } = priceTimes(T1, '1d');
    const mockFetchPerpKlinesRange = vi.fn().mockResolvedValue([
      {
        openTime: start,
        closeTime: start + 300_000 - 1,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1000,
        quoteVolume: 100_000,
        trades: 50,
        takerBuyVolume: 500,
      },
      {
        openTime: end,
        closeTime: end + 300_000 - 1,
        open: 102,
        high: 103,
        low: 101,
        close: 102,
        volume: 1000,
        quoteVolume: 100_000,
        trades: 50,
        takerBuyVolume: 500,
      },
    ]);

    // Coverage is missing for BTCUSDT
    const mockFundingSumsFor = vi.fn().mockResolvedValue({
      sums: { BTCUSDT: 0.0005 },
      coverage: { BTCUSDT: false },
    });

    const nowFresh = gradeDueAt(T1, '1d') + 1000;
    const depsFresh: LabGradeDeps = {
      fetchPerpKlinesRange: mockFetchPerpKlinesRange,
      fundingSumsFor: mockFundingSumsFor,
      clock: () => nowFresh,
    };

    const reportFresh = await runLabGrade(nowFresh, depsFresh);
    expect(reportFresh.graded).toHaveLength(0);
    expect(reportFresh.pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hypothesis: 'N3-1d', barClose: T1 }),
      ])
    );
    expect(reportFresh.errors).toHaveLength(0);
    const rowFresh = await LabScore.findOne({ hypothesis: 'N3-1d', barClose: T1 }).lean();
    expect(rowFresh).toBeNull();

    // Now older than 48 hours past windowEnd
    const nowOld = end + 49 * 3600_000;
    const depsOld: LabGradeDeps = {
      fetchPerpKlinesRange: mockFetchPerpKlinesRange,
      fundingSumsFor: mockFundingSumsFor,
      clock: () => nowOld,
    };

    const reportOld = await runLabGrade(nowOld, depsOld);
    expect(reportOld.graded).toHaveLength(0);
    expect(reportOld.errors.some((e) => e.includes('coverage gap older than 48 hours') && e.includes('BTCUSDT'))).toBe(true);
    const rowOld = await LabScore.findOne({ hypothesis: 'N3-1d', barClose: T1 }).lean();
    expect(rowOld).toBeNull();
  });
});

describe('defaultFundingSumsFor', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await FundingSettlement.init();
  }, 30_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  afterEach(async () => {
    await FundingSettlement.deleteMany({});
  });

  it('reports coverage true when settlement exists in (windowEnd - 8h, windowEnd]', async () => {
    const windowEnd = Date.UTC(2026, 9, 19, 0); // 00:00 UTC
    const windowStart = windowEnd - 86_400_000; // 24h prior

    // Settlement within 8 hours of windowEnd (e.g. at windowEnd - 1h)
    await FundingSettlement.create({
      symbol: 'BTCUSDT',
      fundingTime: windowEnd - 3600_000,
      rate: 0.0002,
      rawTime: windowEnd - 3600_000,
      source: 'rest',
    });
    // Earlier settlement in the window
    await FundingSettlement.create({
      symbol: 'BTCUSDT',
      fundingTime: windowStart + 3600_000,
      rate: 0.0001,
      rawTime: windowStart + 3600_000,
      source: 'rest',
    });

    const res = await defaultFundingSumsFor(['BTCUSDT', 'ETHUSDT'], windowStart, windowEnd);

    expect(res.coverage.BTCUSDT).toBe(true);
    expect(res.sums.BTCUSDT).toBeCloseTo(0.0003, 10);

    // ETHUSDT has no settlements: coverage false, not defaulted to 0
    expect(res.coverage.ETHUSDT).toBe(false);
    expect(res.sums.ETHUSDT).toBeUndefined();
  });

  it('reports coverage false when settlement exists only before (windowEnd - 8h, windowEnd]', async () => {
    const windowEnd = Date.UTC(2026, 9, 19, 0);
    const windowStart = windowEnd - 86_400_000;

    // Settlement exists but is 12 hours before windowEnd (outside the 8h coverage window)
    await FundingSettlement.create({
      symbol: 'BTCUSDT',
      fundingTime: windowEnd - 12 * 3600_000,
      rate: 0.0002,
      rawTime: windowEnd - 12 * 3600_000,
      source: 'rest',
    });

    const res = await defaultFundingSumsFor(['BTCUSDT'], windowStart, windowEnd);

    expect(res.coverage.BTCUSDT).toBe(false);
    expect(res.sums.BTCUSDT).toBeCloseTo(0.0002, 10);
  });
});
