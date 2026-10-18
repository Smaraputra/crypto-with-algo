import { describe, it, expect } from 'vitest';
import {
  clip,
  groupTradesByDay,
  roundUpTo2SigFigs,
  runEProcessOnXSeries,
} from './lab-v2-preview';
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

  describe('day grouping of trades into mean R', () => {
    it('groups trades by openT and calculates R = mean(netPct) / 100', () => {
      const day1 = 1631577600000;
      const day2 = day1 + 86_400_000;

      const trades: Trade[] = [
        {
          symbol: 'BTCUSDT',
          openT: day1,
          closeT: day1 + 86_400_000,
          d: 1,
          grossPct: 1.14,
          netPct: 1.0,
        },
        {
          symbol: 'ETHUSDT',
          openT: day1,
          closeT: day1 + 86_400_000,
          d: -1,
          grossPct: 2.14,
          netPct: 2.0,
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
      // Day 1: mean(1.0, 2.0) = 1.5% -> R = 0.015, trades = 2
      expect(bars[0]).toEqual({
        t: day1,
        R: 0.015,
        trades: 2,
      });
      // Day 2: mean(-1.0) = -1.0% -> R = -0.01, trades = 1
      expect(bars[1]).toEqual({
        t: day2,
        R: -0.01,
        trades: 1,
      });

      expect(tradesByDay.get(day1)).toHaveLength(2);
      expect(tradesByDay.get(day2)).toHaveLength(1);
    });

    it('ignores days with no trades', () => {
      const { bars, tradesByDay } = groupTradesByDay([]);
      expect(bars).toEqual([]);
      expect(tradesByDay.size).toBe(0);
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
});
