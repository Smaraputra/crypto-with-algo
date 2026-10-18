// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { CandleRow } from './dataset-format';
import {
  C2_GUARD_MESSAGE,
  COST_RATE,
  DAY_MS,
  WEEK_MS,
  areFeaturesFinite,
  assertC2Allowed,
  computeTurnover,
  dailyReturns,
  featuresAt,
  filterEligibleCoins,
  ridgeFit,
  ridgePredict,
  runScreenAndPlacebo,
  screenCells,
  targetAt,
  walkForward,
  weeklyRebalances,
  zscoreAcross,
  type PreparedCoinWeek,
  type PreparedDataset,
  type PreparedWeek,
} from './nv1-c2';
import { NV1_SEGMENTS } from './nv1-core';
import { createSeededRandom } from '../../src/lib/stats/seeded-random';

describe('dailyReturns', () => {
  it('computes daily simple returns and drops returns across gaps', () => {
    const t0 = Date.UTC(2022, 0, 1);
    const candles: CandleRow[] = [
      { t: t0, o: 100, h: 105, l: 95, c: 100, v: 1000, tbv: 500 },
      { t: t0 + DAY_MS, o: 100, h: 115, l: 98, c: 110, v: 1000, tbv: 500 }, // +10%
      { t: t0 + 2 * DAY_MS, o: 110, h: 125, l: 105, c: 121, v: 1000, tbv: 500 }, // +10%
      // Gap at day 3 (missing)
      { t: t0 + 4 * DAY_MS, o: 121, h: 135, l: 120, c: 130, v: 1000, tbv: 500 }, // day after gap -> dropped
      { t: t0 + 5 * DAY_MS, o: 130, h: 145, l: 125, c: 143, v: 1000, tbv: 500 }, // +10%
    ];

    const rets = dailyReturns(candles);
    expect(rets).toHaveLength(3);
    expect(rets[0].t).toBe(t0 + DAY_MS);
    expect(rets[0].r).toBeCloseTo(0.1, 6);
    expect(rets[1].t).toBe(t0 + 2 * DAY_MS);
    expect(rets[1].r).toBeCloseTo(0.1, 6);
    expect(rets[2].t).toBe(t0 + 5 * DAY_MS);
    expect(rets[2].r).toBeCloseTo(0.1, 6);

    // Map lookup
    expect(rets.get(t0 + DAY_MS)).toBeCloseTo(0.1, 6);
    expect(rets.get(t0 + 4 * DAY_MS)).toBeUndefined();
  });
});

describe('weeklyRebalances', () => {
  it('returns Mondays at 00:00:00 UTC strictly within the range', () => {
    // 2022-01-01 was a Saturday
    const start = Date.UTC(2022, 0, 1);
    // 2022-01-24 was Monday 00:00 UTC
    const end = Date.UTC(2022, 0, 24);

    const mondays = weeklyRebalances(start, end);
    expect(mondays).toHaveLength(4);
    expect(mondays[0]).toBe(Date.UTC(2022, 0, 3));
    expect(mondays[1]).toBe(Date.UTC(2022, 0, 10));
    expect(mondays[2]).toBe(Date.UTC(2022, 0, 17));
    expect(mondays[3]).toBe(Date.UTC(2022, 0, 24));

    for (const m of mondays) {
      const d = new Date(m);
      expect(d.getUTCDay()).toBe(1);
      expect(d.getUTCHours()).toBe(0);
      expect(d.getUTCMinutes()).toBe(0);
      expect(d.getUTCSeconds()).toBe(0);
    }
  });
});

describe('zscoreAcross', () => {
  it('computes sample z-score and sets to 0 when variance is zero', () => {
    const vals = [10, 20, 30, 40, 50];
    const z = zscoreAcross(vals);
    expect(z).toHaveLength(5);
    const meanZ = z.reduce((a, b) => a + b, 0) / 5;
    expect(meanZ).toBeCloseTo(0, 6);

    const constantVals = [5, 5, 5, 5];
    const zConst = zscoreAcross(constantVals);
    expect(zConst).toEqual([0, 0, 0, 0]);
  });
});

describe('targetAt', () => {
  it('returns zero for BTCUSDT and computes 7-day residual for altcoins', () => {
    const M = Date.UTC(2022, 0, 10); // Monday
    const startT = M - DAY_MS;

    const btcCandles: CandleRow[] = [];
    const altCandles: CandleRow[] = [];

    // 8 days: Sunday before M to Sunday after M
    for (let i = 0; i < 8; i++) {
      const t = startT + i * DAY_MS;
      btcCandles.push({
        t,
        o: 100,
        h: 102,
        l: 98,
        c: 100 * (1 + 0.01 * i),
        v: 1000,
        tbv: 500,
      });
      altCandles.push({
        t,
        o: 100,
        h: 104,
        l: 96,
        c: 100 * (1 + 0.03 * i),
        v: 1000,
        tbv: 500,
      });
    }

    const btcTarget = targetAt('BTCUSDT', M, 1.0, btcCandles, btcCandles);
    expect(btcTarget).toBe(0);

    const altTarget = targetAt('ALT', M, 2.0, altCandles, btcCandles);
    expect(altTarget).not.toBeNull();
    expect(Number.isFinite(altTarget)).toBe(true);
  });
});

describe('Brief requirements', () => {
  it('ridgeFit recovers known slopes on a noiseless 200-row problem with lambda 1e-9, and shrinks them towards 0 with lambda 1e6; the intercept is not penalised', () => {
    const rand = createSeededRandom(12345);
    const N = 200;
    const trueIntercept = 3.5;
    const trueSlopes = [1.2, -0.8, 2.5, -1.5, 0.7];
    const X: number[][] = [];
    const y: number[] = [];

    for (let i = 0; i < N; i++) {
      const row = [
        (rand() - 0.5) * 4,
        (rand() - 0.5) * 4,
        (rand() - 0.5) * 4,
        (rand() - 0.5) * 4,
        (rand() - 0.5) * 4,
      ];
      X.push(row);
      let yi = trueIntercept;
      for (let j = 0; j < 5; j++) {
        yi += row[j] * trueSlopes[j];
      }
      y.push(yi);
    }

    const fitLow = ridgeFit(X, y, 1e-9);
    expect(fitLow.intercept).toBeCloseTo(trueIntercept, 4);
    for (let j = 0; j < 5; j++) {
      expect(fitLow.slopes[j]).toBeCloseTo(trueSlopes[j], 4);
    }

    const pred = ridgePredict(fitLow, X[0]);
    expect(pred).toBeCloseTo(y[0], 4);

    const fitHigh = ridgeFit(X, y, 1e6);
    for (let j = 0; j < 5; j++) {
      expect(Math.abs(fitHigh.slopes[j])).toBeLessThan(1e-3);
    }

    // Intercept is not penalised, so it approximates the mean of y
    const meanY = y.reduce((a, b) => a + b, 0) / N;
    expect(fitHigh.intercept).toBeCloseTo(meanY, 2);
    expect(Math.abs(fitHigh.intercept)).toBeGreaterThan(1.0);
  });

  it('featuresAt: a coin whose returns are exactly 2 x BTCs has beta 2 and residual features 0; beta clamps at 3 for 10 x BTC', () => {
    const M = Date.UTC(2022, 5, 6); // Monday
    const startT = M - 95 * DAY_MS;
    const rand = createSeededRandom(42);

    const btcCandles: CandleRow[] = [];
    let btcPrice = 20000;
    const btcReturns: number[] = [];

    for (let i = 0; i < 95; i++) {
      const t = startT + i * DAY_MS;
      const r = (rand() - 0.5) * 0.04;
      btcReturns.push(r);
      const open = btcPrice;
      const close = btcPrice * (1 + r);
      btcCandles.push({
        t,
        o: open,
        h: Math.max(open, close),
        l: Math.min(open, close),
        c: close,
        v: 1000,
        tbv: 500,
      });
      btcPrice = close;
    }

    // Coin 2x: daily returns are exactly 2 * btcReturns
    const coin2xCandles: CandleRow[] = [];
    let price2x = 100;
    for (let i = 0; i < 95; i++) {
      const t = startT + i * DAY_MS;
      const r = 2 * btcReturns[i];
      const open = price2x;
      const close = price2x * (1 + r);
      coin2xCandles.push({
        t,
        o: open,
        h: Math.max(open, close),
        l: Math.min(open, close),
        c: close,
        v: 1000,
        tbv: 500,
      });
      price2x = close;
    }

    const f2x = featuresAt('COIN2X', M, coin2xCandles, btcCandles);
    expect(f2x.beta).toBeCloseTo(2.0, 5);
    expect(f2x.res1w).toBeCloseTo(0.0, 5);
    expect(f2x.res4w).toBeCloseTo(0.0, 5);

    // Coin 10x: daily returns are exactly 10 * btcReturns
    const coin10xCandles: CandleRow[] = [];
    let price10x = 100;
    for (let i = 0; i < 95; i++) {
      const t = startT + i * DAY_MS;
      const r = 10 * btcReturns[i];
      const open = price10x;
      const close = price10x * (1 + r);
      coin10xCandles.push({
        t,
        o: open,
        h: Math.max(open, close),
        l: Math.min(open, close),
        c: close,
        v: 1000,
        tbv: 500,
      });
      price10x = close;
    }

    const f10x = featuresAt('COIN10X', M, coin10xCandles, btcCandles);
    expect(f10x.beta).toBe(3.0);
  });

  it('tbs1w excludes zero-volume days; vtrend on constant volume is 1', () => {
    const M = Date.UTC(2022, 5, 6);
    const startT = M - 95 * DAY_MS;

    const btcCandles: CandleRow[] = [];
    for (let i = 0; i < 95; i++) {
      const t = startT + i * DAY_MS;
      btcCandles.push({
        t,
        o: 100,
        h: 101,
        l: 99,
        c: 100,
        v: 1000,
        tbv: 500,
      });
    }

    const candles: CandleRow[] = [];
    for (let i = 0; i < 95; i++) {
      const t = startT + i * DAY_MS;
      let v = 500;
      let tbv = 250;
      if (i >= 88) {
        if (i % 2 === 0) {
          v = 0;
          tbv = 0;
        } else {
          v = 100;
          tbv = 60;
        }
      }
      candles.push({
        t,
        o: 100,
        h: 101,
        l: 99,
        c: 100,
        v,
        tbv,
      });
    }

    const f = featuresAt('TESTCOIN', M, candles, btcCandles);
    expect(f.tbs1w).toBeCloseTo(0.6, 5);

    const constVolCandles: CandleRow[] = [];
    for (let i = 0; i < 95; i++) {
      const t = startT + i * DAY_MS;
      constVolCandles.push({
        t,
        o: 100,
        h: 101,
        l: 99,
        c: 100,
        v: 750,
        tbv: 375,
      });
    }
    const fConst = featuresAt('TESTCOIN', M, constVolCandles, btcCandles);
    expect(fConst.vtrend).toBeCloseTo(1.0, 5);
  });

  it('Embargo: in walkForward, the training set at M never contains a week W with W + 7 days > M (assert on the recorded training weeks via an optional debug hook)', () => {
    const numCoins = 8;
    const numWeeks = 30;
    const startMonday = Date.UTC(2022, 0, 3);
    const startT = startMonday - 95 * DAY_MS;
    const endT = startMonday + numWeeks * WEEK_MS;
    const totalDays = Math.ceil((endT - startT) / DAY_MS);

    const rand = createSeededRandom(999);
    const candlesBySymbol: Record<string, CandleRow[]> = {};

    for (let c = 0; c < numCoins; c++) {
      const sym = c === 0 ? 'BTCUSDT' : `SYNTH_${c}`;
      const rows: CandleRow[] = [];
      let price = 100 + c * 20;

      for (let d = 0; d < totalDays; d++) {
        const t = startT + d * DAY_MS;
        const ret = (rand() - 0.5) * 0.02;
        const open = price;
        const close = price * (1 + ret);
        rows.push({
          t,
          o: open,
          h: Math.max(open, close) * 1.01,
          l: Math.min(open, close) * 0.99,
          c: close,
          v: 1000 + rand() * 200,
          tbv: 500,
        });
        price = close;
      }
      candlesBySymbol[sym] = rows;
    }

    let hookCalled = 0;
    walkForward(candlesBySymbol, 'all', 0, {
      testStart: startMonday + 5 * WEEK_MS,
      testEnd: startMonday + 25 * WEEK_MS,
      onTrainingWeeks: (M, trainingWeeks) => {
        hookCalled++;
        for (const W of trainingWeeks) {
          expect(W + WEEK_MS).toBeLessThanOrEqual(M);
        }
      },
    });

    expect(hookCalled).toBeGreaterThan(0);
  });

  it('Delay k: hand-built predictions where one coin flips sign each week make it ineligible for k >= 1', () => {
    const coins = ['COIN_FLIP', 'COIN_STABLE_POS', 'COIN_STABLE_NEG'];
    const weeklySigns = new Map<number, Map<string, number>>();

    // 4 weeks: 0, 1, 2, 3
    const baseM = Date.UTC(2022, 0, 3);
    const week0 = baseM;
    const week1 = baseM + WEEK_MS;
    const week2 = baseM + 2 * WEEK_MS;
    const week3 = baseM + 3 * WEEK_MS;

    weeklySigns.set(
      week0,
      new Map([
        ['COIN_FLIP', 1],
        ['COIN_STABLE_POS', 1],
        ['COIN_STABLE_NEG', -1],
      ])
    );

    weeklySigns.set(
      week1,
      new Map([
        ['COIN_FLIP', -1],
        ['COIN_STABLE_POS', 1],
        ['COIN_STABLE_NEG', -1],
      ])
    );

    weeklySigns.set(
      week2,
      new Map([
        ['COIN_FLIP', 1],
        ['COIN_STABLE_POS', 1],
        ['COIN_STABLE_NEG', -1],
      ])
    );

    weeklySigns.set(
      week3,
      new Map([
        ['COIN_FLIP', -1],
        ['COIN_STABLE_POS', 1],
        ['COIN_STABLE_NEG', -1],
      ])
    );

    // At week 1: COIN_FLIP has sign -1, previous was +1 (different sign)
    expect(filterEligibleCoins(coins, weeklySigns, week1, 0)).toContain('COIN_FLIP');
    expect(filterEligibleCoins(coins, weeklySigns, week1, 1)).not.toContain('COIN_FLIP');
    expect(filterEligibleCoins(coins, weeklySigns, week1, 2)).not.toContain('COIN_FLIP');
    expect(filterEligibleCoins(coins, weeklySigns, week1, 3)).not.toContain('COIN_FLIP');

    // At week 2: COIN_FLIP has sign +1, previous was -1
    expect(filterEligibleCoins(coins, weeklySigns, week2, 0)).toContain('COIN_FLIP');
    expect(filterEligibleCoins(coins, weeklySigns, week2, 1)).not.toContain('COIN_FLIP');
    expect(filterEligibleCoins(coins, weeklySigns, week2, 2)).not.toContain('COIN_FLIP');

    // Meanwhile stable coins stay eligible across k
    expect(filterEligibleCoins(coins, weeklySigns, week1, 1)).toContain('COIN_STABLE_POS');
    expect(filterEligibleCoins(coins, weeklySigns, week1, 1)).toContain('COIN_STABLE_NEG');
  });

  it('Cash: with 5 coins every week is cash', () => {
    const numCoins = 5;
    const numWeeks = 15;
    const startMonday = Date.UTC(2022, 0, 3);
    const startT = startMonday - 95 * DAY_MS;
    const totalDays = 95 + numWeeks * 7;
    const rand = createSeededRandom(777);

    const candlesBySymbol: Record<string, CandleRow[]> = {};
    for (let c = 0; c < numCoins; c++) {
      const sym = c === 0 ? 'BTCUSDT' : `COIN_${c}`;
      const rows: CandleRow[] = [];
      let price = 100;
      for (let d = 0; d < totalDays; d++) {
        const t = startT + d * DAY_MS;
        const ret = (rand() - 0.5) * 0.02;
        rows.push({
          t,
          o: price,
          h: price * 1.01,
          l: price * 0.99,
          c: price * (1 + ret),
          v: 1000,
          tbv: 500,
        });
        price = price * (1 + ret);
      }
      candlesBySymbol[sym] = rows;
    }

    const results = walkForward(candlesBySymbol, 'all', 0, {
      testStart: startMonday,
      testEnd: startMonday + 10 * WEEK_MS,
    });

    expect(results.length).toBeGreaterThan(0);
    for (const week of results) {
      expect(week.cash).toBe(true);
      expect(week.eligible).toBeLessThan(6);
      expect(Number.isNaN(week.ic)).toBe(true);
    }
  });

  it('A planted predictive feature on synthetic data gives a mean IC clearly above 0 and above the placebo 90th percentile, while a pure-noise setup does not pass the screen for the fixed seed (small counts: 30 placebo permutations)', () => {
    // 8 coins across 50 weeks: 15 training weeks, 15 segment B weeks, 20 segment C weeks
    const numCoins = 8;
    const numWeeks = 50;
    const startMonday = Date.UTC(2022, 0, 3);
    const startT = startMonday - 95 * DAY_MS;
    const totalDays = 95 + numWeeks * 7;

    const segBStart = startMonday + 15 * WEEK_MS;
    const segCEnd = startMonday + 50 * WEEK_MS;

    const makeData = (planted: boolean, seed: number): Record<string, CandleRow[]> => {
      const rand = createSeededRandom(seed);
      const dataset: Record<string, CandleRow[]> = {};

      // Deterministic coin feature values per week
      const coinTbs = Array.from({ length: numWeeks + 1 }, () =>
        Array.from({ length: numCoins }, (_, c) => (c === 0 ? 0.5 : 0.2 + (c / 7) * 0.6))
      );

      for (let c = 0; c < numCoins; c++) {
        const sym = c === 0 ? 'BTCUSDT' : `SYNTH_${c}`;
        const rows: CandleRow[] = [];
        let price = 100;

        for (let d = 0; d < totalDays; d++) {
          const t = startT + d * DAY_MS;
          const weekIdx = Math.floor((d - 95) / 7);

          let ret = (rand() - 0.5) * 0.01;
          let tbvRatio = 0.5;

          if (weekIdx >= 0 && weekIdx < numWeeks) {
            tbvRatio = coinTbs[weekIdx][c];
            if (planted && c > 0) {
              // Next week return is predicted by this week's tbv feature
              const prevW = weekIdx - 1;
              if (prevW >= 0) {
                const signal = coinTbs[prevW][c] - 0.5;
                ret += 0.5 * (signal / 7) + (rand() - 0.5) * 0.002;
              }
            }
          }

          const open = price;
          const close = price * (1 + ret);
          const v = 1000;
          const tbv = v * tbvRatio;

          rows.push({
            t,
            o: open,
            h: Math.max(open, close) * 1.005,
            l: Math.min(open, close) * 0.995,
            c: close,
            v,
            tbv,
          });
          price = close;
        }

        dataset[sym] = rows;
      }

      return dataset;
    };

    // 1. Planted signal setup
    const plantedDataset = makeData(true, 4242);
    const plantedResult = runScreenAndPlacebo(plantedDataset, 30, {
      testStart: segBStart,
      testEnd: segCEnd - WEEK_MS,
    });

    // Lookback 156 with k = 0
    const plantedCell = plantedResult.cells.find((c) => c.k === 0);
    expect(plantedCell).toBeDefined();
    expect(plantedCell!.meanIcBC).toBeGreaterThan(0.1);
    expect(plantedCell!.meanIcBC).toBeGreaterThan(plantedCell!.placeboP90Ic);

    // 2. Pure noise setup
    const noiseDataset = makeData(false, 9999);
    const noiseResult = runScreenAndPlacebo(noiseDataset, 30, {
      testStart: segBStart,
      testEnd: segCEnd - WEEK_MS,
    });

    // In pure noise setup, cells do not survive the screen rule
    expect(noiseResult.survivor).toBeNull();

    // The noise setup's placebo 90th percentile is above 0 and its expected null promotion rate is within [0, 1]
    const noiseCell = noiseResult.cells.find((c) => c.k === 0);
    expect(noiseCell).toBeDefined();
    expect(noiseCell!.placeboP90Ic).toBeGreaterThan(0);
    expect(noiseResult.nullPromotionRate).toBeGreaterThanOrEqual(0);
    expect(noiseResult.nullPromotionRate).toBeLessThanOrEqual(1);
  });

  it('The CLI guard throws the exact message without the lock file (export assertC2Allowed(scriptDir))', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nv1-c2-guard-test-'));
    try {
      expect(() => assertC2Allowed(tempDir)).toThrow(C2_GUARD_MESSAGE);
      expect(() => assertC2Allowed(tempDir)).toThrow(
        'nv1: C2 trains on segment A and runs only after the Round 1 lock is committed'
      );

      writeFileSync(join(tempDir, 'next-version-v1.ts'), '// Lock file\n');
      expect(() => assertC2Allowed(tempDir)).not.toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a hand-built two-coin-pair book over three weeks where week 2 is cash: week 1 cost is 0.0007 x entry turnover (gross 1), week 2 net is minus 0.0007 x 1 (liquidation), week 3 cost is 0.0007 x 1 again (full re-entry)', () => {
    // Week 1: entry with pair of coins (gross exposure 1.0)
    let prevWeights = new Map<string, number>();
    const week1Weights = new Map<string, number>([
      ['COIN_A', 0.5],
      ['COIN_B', -0.5],
    ]);
    const turnover1 = computeTurnover(prevWeights, week1Weights);
    const cost1 = COST_RATE * turnover1;
    expect(turnover1).toBe(1.0);
    expect(cost1).toBeCloseTo(0.0007 * 1, 8);
    prevWeights = week1Weights;

    // Week 2: cash week (liquidation)
    const week2Weights = new Map<string, number>();
    const turnover2 = computeTurnover(prevWeights, week2Weights);
    const cost2 = COST_RATE * turnover2;
    const net2 = -cost2;
    expect(turnover2).toBe(1.0);
    expect(net2).toBeCloseTo(-0.0007 * 1, 8);
    prevWeights = week2Weights;

    // Week 3: full re-entry
    const week3Weights = new Map<string, number>([
      ['COIN_A', 0.5],
      ['COIN_B', -0.5],
    ]);
    const turnover3 = computeTurnover(prevWeights, week3Weights);
    const cost3 = COST_RATE * turnover3;
    expect(turnover3).toBe(1.0);
    expect(cost3).toBeCloseTo(0.0007 * 1, 8);
  });

  it('turnover when one coin leaves and another enters: the cost equals 0.0007 x the sum of absolute weight changes over the union of coins', () => {
    const prevWeights = new Map<string, number>([
      ['COIN_A', 0.5],
      ['COIN_B', -0.5],
    ]);
    const currentWeights = new Map<string, number>([
      ['COIN_A', 0.5],
      ['COIN_C', -0.5],
    ]);

    const turnover = computeTurnover(prevWeights, currentWeights);
    const cost = COST_RATE * turnover;

    const allSymbols = new Set<string>([...prevWeights.keys(), ...currentWeights.keys()]);
    let expectedAbsDiffSum = 0;
    for (const sym of allSymbols) {
      const wPrev = prevWeights.get(sym) ?? 0;
      const wCurr = currentWeights.get(sym) ?? 0;
      expectedAbsDiffSum += Math.abs(wCurr - wPrev);
    }

    expect(expectedAbsDiffSum).toBe(1.0);
    expect(turnover).toBe(expectedAbsDiffSum);
    expect(cost).toBeCloseTo(0.0007 * expectedAbsDiffSum, 8);
  });

  it('an incomplete week is marked incomplete, treated as cash, counted, and the next week turnover is a full re-entry', () => {
    const symbols = ['COIN_0', 'COIN_1', 'COIN_2', 'COIN_3', 'COIN_4', 'COIN_5'];
    const startM = NV1_SEGMENTS.B.start;
    const weeks: PreparedWeek[] = [];

    // 20 training weeks
    for (let w = 20; w >= 1; w--) {
      const M = startM - w * WEEK_MS;
      const coinData = new Map<string, PreparedCoinWeek>();
      for (let i = 0; i < symbols.length; i++) {
        coinData.set(symbols[i], {
          symbol: symbols[i],
          rawFeatures: {
            beta: 1.0,
            res1w: i * 0.1,
            res4w: i * 0.2,
            vol4w: 0.05,
            tbs1w: 0.5 + i * 0.05,
            vtrend: 1.0,
          },
          target: i * 0.02,
          rawForwardReturn: i * 0.02,
        });
      }
      weeks.push({ M, coinData });
    }

    // Week 1 (M0): complete returns
    const M0 = startM;
    const coinData0 = new Map<string, PreparedCoinWeek>();
    for (let i = 0; i < symbols.length; i++) {
      coinData0.set(symbols[i], {
        symbol: symbols[i],
        rawFeatures: {
          beta: 1.0,
          res1w: i * 0.1,
          res4w: i * 0.2,
          vol4w: 0.05,
          tbs1w: 0.5 + i * 0.05,
          vtrend: 1.0,
        },
        target: i * 0.02,
        rawForwardReturn: 0.01,
      });
    }
    weeks.push({ M: M0, coinData: coinData0 });

    // Week 2 (M1): COIN_0 has null forward return -> incomplete week
    const M1 = startM + WEEK_MS;
    const coinData1 = new Map<string, PreparedCoinWeek>();
    for (let i = 0; i < symbols.length; i++) {
      coinData1.set(symbols[i], {
        symbol: symbols[i],
        rawFeatures: {
          beta: 1.0,
          res1w: i * 0.1,
          res4w: i * 0.2,
          vol4w: 0.05,
          tbs1w: 0.5 + i * 0.05,
          vtrend: 1.0,
        },
        target: i * 0.02,
        rawForwardReturn: i === 0 ? null : 0.01,
      });
    }
    weeks.push({ M: M1, coinData: coinData1 });

    // Week 3 (M2): complete returns
    const M2 = startM + 2 * WEEK_MS;
    const coinData2 = new Map<string, PreparedCoinWeek>();
    for (let i = 0; i < symbols.length; i++) {
      coinData2.set(symbols[i], {
        symbol: symbols[i],
        rawFeatures: {
          beta: 1.0,
          res1w: i * 0.1,
          res4w: i * 0.2,
          vol4w: 0.05,
          tbs1w: 0.5 + i * 0.05,
          vtrend: 1.0,
        },
        target: i * 0.02,
        rawForwardReturn: 0.01,
      });
    }
    weeks.push({ M: M2, coinData: coinData2 });

    const prepared: PreparedDataset = {
      weeks,
      byM: new Map(weeks.map((w) => [w.M, w])),
      symbols,
      droppedCoinWeeks: { training: 0, B: 0, C: 0 },
    };

    const results = walkForward(prepared, 'all', 0, {
      testStart: M0,
      testEnd: M2,
    });

    expect(results).toHaveLength(3);

    // Week 1 was complete and formed a book
    expect(results[0].incomplete).toBe(false);
    expect(results[0].cash).toBe(false);
    expect(results[0].turnover).toBe(1.0);

    // Week 2 is incomplete: marked incomplete, treated as cash (net = -cost of liquidation, ic is NaN)
    expect(results[1].incomplete).toBe(true);
    expect(results[1].cash).toBe(false);
    expect(Number.isNaN(results[1].ic)).toBe(true);
    expect(results[1].turnover).toBe(1.0);
    expect(results[1].net).toBeCloseTo(-COST_RATE * 1.0, 8);

    // Week 3: after cash/incomplete week, turnover is a full re-entry
    expect(results[2].incomplete).toBe(false);
    expect(results[2].cash).toBe(false);
    expect(results[2].turnover).toBe(1.0);

    // Counted in summary as incompleteWeeksB
    const screen = screenCells(
      [{ lookback: 'all', k: 0, weeks: results }],
      { cellMeanIcs: new Map(), nullPromotionRate: 0 },
      prepared.droppedCoinWeeks
    );
    expect(screen.cells[0].incompleteWeeksB).toBe(1);
    expect(screen.cells[0].incompleteWeeksC).toBe(0);
  });

  it('a day with v > 0 and tbv null makes tbs1w NaN', () => {
    const M = Date.UTC(2022, 5, 6);
    const startT = M - 95 * DAY_MS;

    const btcCandles: CandleRow[] = [];
    for (let i = 0; i < 95; i++) {
      const t = startT + i * DAY_MS;
      btcCandles.push({
        t,
        o: 100,
        h: 101,
        l: 99,
        c: 100,
        v: 1000,
        tbv: 500,
      });
    }

    const candles: CandleRow[] = [];
    for (let i = 0; i < 95; i++) {
      const t = startT + i * DAY_MS;
      const isNullTbvDay = i === 88;
      candles.push({
        t,
        o: 100,
        h: 101,
        l: 99,
        c: 100,
        v: 1000,
        tbv: isNullTbvDay ? null : 500,
      });
    }

    const f = featuresAt('TESTCOIN', M, candles, btcCandles);
    expect(Number.isNaN(f.tbs1w)).toBe(true);
    expect(areFeaturesFinite(f)).toBe(false);
  });
});
