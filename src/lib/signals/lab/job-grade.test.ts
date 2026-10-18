import { describe, expect, it } from 'vitest';

import { initialEState } from '@/lib/signals/lab/e-process';
import {
  gradeBar,
  gradeDueAt,
  LAB_GRADE_SETTLE_MS,
  priceTimes,
  type GradeInput,
} from '@/lib/signals/lab/job-grade';
import {
  bookReturn,
  kN,
  kNNoTies,
  populationSd,
  rankWeightedCorrelation,
} from '@/lib/stats/rank-ic';

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
