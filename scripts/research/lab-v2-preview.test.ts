import { describe, it, expect } from 'vitest';
import {
  clip,
  computeC3Stats,
  groupTradesByDay,
  initialBookEState,
  roundUpTo2SigFigs,
  runC2NullSimulation,
  runEProcessOnXSeries,
  stepBookE,
  toX,
  type BookEState,
} from './lab-v2-preview';
import type { PreparedDataset, WalkForwardWeekResult } from './nv1-c2';
import type { Trade } from './nv1-core';

describe('lab-v2-preview', () => {
  describe('scale rounding', () => {
    it('rounds positive numbers up to 2 significant figures', () => {
      // Required values from brief:
      expect(roundUpTo2SigFigs(0.0213)).toBe(0.022);
      expect(roundUpTo2SigFigs(0.1)).toBe(0.1);
      expect(roundUpTo2SigFigs(0.00456)).toBe(0.0046);
    });

    it('handles exact 2 significant figure inputs without rounding up', () => {
      expect(roundUpTo2SigFigs(0.022)).toBe(0.022);
      expect(roundUpTo2SigFigs(0.05)).toBe(0.05);
      expect(roundUpTo2SigFigs(12)).toBe(12);
    });

    it('handles other magnitudes correctly', () => {
      expect(roundUpTo2SigFigs(0.0991)).toBe(0.1);
      expect(roundUpTo2SigFigs(1.23)).toBe(1.3);
      expect(roundUpTo2SigFigs(123)).toBe(130);
    });
  });

  describe('toX (gains-only clip)', () => {
    it('clips gains at 1 and keeps losses unclipped', () => {
      expect(toX(0.5, 0.25)).toBe(1);
      expect(toX(-0.75, 0.25)).toBe(-3);
    });
  });

  describe('clip', () => {
    it('clips values into [-1, 1]', () => {
      expect(clip(0.5, -1, 1)).toBe(0.5);
      expect(clip(1.5, -1, 1)).toBe(1);
      expect(clip(-1.5, -1, 1)).toBe(-1);
      expect(clip(-1, -1, 1)).toBe(-1);
      expect(clip(1, -1, 1)).toBe(1);
      expect(clip(0, -1, 1)).toBe(0);
    });
  });

  describe('stepBookE', () => {
    it('absorbs when factor <= 0 and leaves subsequent steps unchanged', () => {
      // State with n = 30, mean 0.1 and variance 0.01 (lambda capped at 0.5)
      // mean = 0.1 -> sum = 30 * 0.1 = 3
      // variance = 0.01 -> sum2 / 30 - 0.01 = 0.01 -> sum2 = 0.6
      const state0: BookEState = {
        n: 30,
        sum: 3,
        sum2: 0.6,
        logE: 0,
        absorbed: false,
        crossedAtBar: null,
      };

      // x = -3 gives factor = 1 + 0.5 * (-3) = -0.5 <= 0
      const state1 = stepBookE(state0, -3, 31, 400);
      expect(state1.absorbed).toBe(true);
      expect(state1.logE).toBe(Number.NEGATIVE_INFINITY);
      expect(state1.crossedAtBar).toBeNull();
      expect(state1.n).toBe(31);
      expect(state1.sum).toBe(0);
      expect(state1.sum2).toBe(9.6);

      // A following x = 1 leaves it absorbed with crossedAtBar null
      const state2 = stepBookE(state1, 1, 32, 400);
      expect(state2.absorbed).toBe(true);
      expect(state2.logE).toBe(Number.NEGATIVE_INFINITY);
      expect(state2.crossedAtBar).toBeNull();
      expect(state2).toEqual(state1);
    });

    it('crosses threshold 400 for constant x = 0.3 once warm-up ends', () => {
      const xSeries = new Array(100).fill(0.3);
      let state = initialBookEState();
      for (let bar = 1; bar <= xSeries.length; bar++) {
        state = stepBookE(state, xSeries[bar - 1], bar, 400);
      }
      expect(state.crossedAtBar).not.toBeNull();
      expect(state.crossedAtBar!).toBeGreaterThan(30);
      expect(state.crossedAtBar!).toBeLessThanOrEqual(100);
      expect(state.logE).toBeGreaterThanOrEqual(Math.log(400));
      expect(state.absorbed).toBe(false);
    });

    it('never crosses for constant x = 0', () => {
      const xSeries = new Array(100).fill(0);
      let state = initialBookEState();
      for (let bar = 1; bar <= xSeries.length; bar++) {
        state = stepBookE(state, xSeries[bar - 1], bar, 400);
      }
      expect(state.crossedAtBar).toBeNull();
      expect(state.logE).toBeLessThan(Math.log(400));
      expect(state.absorbed).toBe(false);
    });
  });

  describe('day grouping of trades into summed R', () => {
    it('groups trades by openT and calculates R = sum(netPct) / 100', () => {
      const day1 = 1631577600000;
      const day2 = day1 + 86_400_000;

      const trades: Trade[] = [
        {
          symbol: 'BTCUSDT',
          openT: day1,
          closeT: day1 + 86_400_000,
          d: 1,
          grossPct: 0.34,
          netPct: 0.2,
        },
        {
          symbol: 'ETHUSDT',
          openT: day1,
          closeT: day1 + 86_400_000,
          d: -1,
          grossPct: 0.04,
          netPct: -0.1,
        },
        {
          symbol: 'SOLUSDT',
          openT: day2,
          closeT: day2 + 86_400_000,
          d: 1,
          grossPct: -0.86,
          netPct: -1.0,
        },
      ];

      const { bars, tradesByDay } = groupTradesByDay(trades);

      expect(bars).toHaveLength(2);
      // Day 1: sum(0.2, -0.1) = 0.1% -> R = 0.001, trades = 2
      expect(bars[0].t).toBe(day1);
      expect(bars[0].R).toBeCloseTo(0.001, 10);
      expect(bars[0].trades).toBe(2);

      // Day 2: sum(-1.0) = -1.0% -> R = -0.01, trades = 1
      expect(bars[1].t).toBe(day2);
      expect(bars[1].R).toBeCloseTo(-0.01, 10);
      expect(bars[1].trades).toBe(1);

      expect(tradesByDay.get(day1)).toHaveLength(2);
      expect(tradesByDay.get(day2)).toHaveLength(1);
    });

    it('ignores days with no trades', () => {
      const { bars, tradesByDay } = groupTradesByDay([]);
      expect(bars).toEqual([]);
      expect(tradesByDay.size).toBe(0);
    });

    it('calculates perTradeMean equal to the pooled mean of netPct / 100', () => {
      const day1 = 1631577600000;
      const day2 = day1 + 86_400_000;
      const day3 = day2 + 86_400_000;

      const trades: Trade[] = [
        {
          symbol: 'BTCUSDT',
          openT: day1,
          closeT: day1 + 86_400_000,
          d: 1,
          grossPct: 0.34,
          netPct: 0.2,
        },
        {
          symbol: 'ETHUSDT',
          openT: day1,
          closeT: day1 + 86_400_000,
          d: -1,
          grossPct: 0.04,
          netPct: -0.1,
        },
        {
          symbol: 'SOLUSDT',
          openT: day2,
          closeT: day2 + 86_400_000,
          d: 1,
          grossPct: 0.64,
          netPct: 0.5,
        },
        {
          symbol: 'AVAXUSDT',
          openT: day3,
          closeT: day3 + 86_400_000,
          d: -1,
          grossPct: -0.16,
          netPct: -0.3,
        },
        {
          symbol: 'BNBUSDT',
          openT: day3,
          closeT: day3 + 86_400_000,
          d: 1,
          grossPct: 0.84,
          netPct: 0.7,
        },
      ];

      const { bars } = groupTradesByDay(trades);
      const stats = computeC3Stats(bars, 365);

      const pooledMean = trades.reduce((sum, tr) => sum + tr.netPct / 100, 0) / trades.length;
      expect(stats.perTradeMean).toBeCloseTo(pooledMean, 10);
      expect(stats.perTradeMean).toBeCloseTo(0.002, 10);
    });
  });

  describe('400-threshold crossing check', () => {
    it('crosses threshold 400 for constant X = 0.3 from bar 31', () => {
      // 100 bars with X = 0.3.
      // Warmup is first 30 bars (bars 1..30).
      // From bar 31 onward, Kelly bets with lambda > 0.
      const xSeries = new Array(100).fill(0.3);
      const res = runEProcessOnXSeries(xSeries, 0);

      expect(res.crossed).toBe(true);
      expect(res.crossedBar).toBeGreaterThanOrEqual(31);
      expect(res.crossedBar).toBeLessThanOrEqual(100);
      expect(res.maxLogE).toBeGreaterThanOrEqual(Math.log(400));
    });

    it('never crosses for constant X = 0', () => {
      const xSeries = new Array(100).fill(0);
      const res = runEProcessOnXSeries(xSeries, 0);

      expect(res.crossed).toBe(false);
      expect(res.crossedBar).toBeNull();
      expect(res.maxLogE).toBeLessThan(Math.log(400));
    });
  });

  describe('runC2NullSimulation incomplete week handling', () => {
    it('treats missing rawForwardReturn as incomplete week with book return 0 and turnover cost to flat', () => {
      const M1 = 1600000000000;
      const weeks: WalkForwardWeekResult[] = [
        { M: M1, ic: 0, net: 0, eligible: 2, cash: false, incomplete: false, turnover: 0 },
      ];
      const prepared = {
        weeks: [],
        byM: new Map([
          [
            M1,
            {
              M: M1,
              coinData: new Map([
                ['BTCUSDT', { rawForwardReturn: null }],
                ['ETHUSDT', { rawForwardReturn: 0.05 }],
              ]),
            },
          ],
        ]),
        droppedCoinWeeks: { training: 0, B: 0, C: 0 },
      } as unknown as PreparedDataset;
      const heldCoinsMap = new Map([[M1, ['BTCUSDT', 'ETHUSDT']]]);
      const res = runC2NullSimulation(weeks, prepared, heldCoinsMap, 0.04, 10, 12345);
      expect(res.nullCrossings).toBe(0);
      expect(res.absorbedShare).toBe(0);
    });
  });
});
