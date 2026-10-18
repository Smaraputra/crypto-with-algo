import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@/types/market';
import {
  DAY_MS,
  levelLabel,
  levelProximity,
  priorDayLevels,
  type PriorDayLevels,
} from './levels';

describe('levels', () => {
  const baseNowMs = Date.UTC(2026, 9, 18, 14, 30, 0);
  const todayStart = Math.floor(baseNowMs / DAY_MS) * DAY_MS;

  function createCandle(
    daysAgo: number,
    high = 110,
    low = 90,
    close = 100,
    open = 100,
    volume = 1000
  ): OHLCV {
    return {
      timestamp: todayStart - daysAgo * DAY_MS,
      open,
      high,
      low,
      close,
      volume,
    };
  }

  describe('priorDayLevels', () => {
    it('handles 20 daily candles ending with a forming day, returning prior day as second to last', () => {
      // daysAgo from 19 down to 0 (20 candles total: 19 completed days + 1 forming day at daysAgo 0)
      const candles: OHLCV[] = [];
      for (let daysAgo = 19; daysAgo >= 0; daysAgo--) {
        if (daysAgo === 1) {
          candles.push(createCandle(daysAgo, 125, 95, 115, 100));
        } else if (daysAgo === 0) {
          // forming day
          candles.push(createCandle(daysAgo, 130, 110, 120, 115));
        } else {
          candles.push(createCandle(daysAgo, 110, 90, 100, 100));
        }
      }

      const result = priorDayLevels(candles, baseNowMs);
      expect(result).not.toBeNull();
      expect(result?.dayStart).toBe(todayStart - DAY_MS);
      expect(result?.high).toBe(125);
      expect(result?.low).toBe(95);
      expect(result?.close).toBe(115);
    });

    it('returns ATR exactly 20 for a constant series (high 110, low 90, close 100, open 100)', () => {
      const candles: OHLCV[] = [];
      for (let daysAgo = 20; daysAgo >= 1; daysAgo--) {
        candles.push(createCandle(daysAgo, 110, 90, 100, 100));
      }

      const result = priorDayLevels(candles, baseNowMs);
      expect(result).not.toBeNull();
      expect(result?.atr).toBe(20);
    });

    it('returns null when the last completed candle is two days old', () => {
      const candles: OHLCV[] = [];
      for (let daysAgo = 20; daysAgo >= 2; daysAgo--) {
        candles.push(createCandle(daysAgo, 110, 90, 100, 100));
      }

      const result = priorDayLevels(candles, baseNowMs);
      expect(result).toBeNull();
    });

    it('returns null for 14 completed candles and a value for 15', () => {
      const candles14: OHLCV[] = [];
      for (let daysAgo = 14; daysAgo >= 1; daysAgo--) {
        candles14.push(createCandle(daysAgo, 110, 90, 100, 100));
      }
      expect(priorDayLevels(candles14, baseNowMs)).toBeNull();

      const candles15: OHLCV[] = [];
      for (let daysAgo = 15; daysAgo >= 1; daysAgo--) {
        candles15.push(createCandle(daysAgo, 110, 90, 100, 100));
      }
      expect(priorDayLevels(candles15, baseNowMs)).not.toBeNull();
    });

    it('overwrites earlier duplicates so the later duplicate wins', () => {
      const candles: OHLCV[] = [];
      for (let daysAgo = 15; daysAgo >= 2; daysAgo--) {
        candles.push(createCandle(daysAgo, 110, 90, 100, 100));
      }
      // First duplicate for prior day
      candles.push(createCandle(1, 105, 95, 100, 100));
      // Later duplicate for prior day (should win)
      candles.push(createCandle(1, 140, 80, 130, 90));

      const result = priorDayLevels(candles, baseNowMs);
      expect(result).not.toBeNull();
      expect(result?.high).toBe(140);
      expect(result?.low).toBe(80);
      expect(result?.close).toBe(130);
    });
  });

  describe('levelProximity', () => {
    const levels: PriorDayLevels = {
      dayStart: todayStart - DAY_MS,
      high: 110,
      low: 90,
      close: 100,
      atr: 20,
    };

    it('returns high level proximity with -0.1 ATR and near: true for price 108', () => {
      const prox = levelProximity(108, levels);
      expect(prox).not.toBeNull();
      expect(prox?.level).toBe('high');
      expect(prox?.price).toBe(108);
      expect(prox?.distanceAtr).toBeCloseTo(-0.1);
      expect(prox?.near).toBe(true);
    });

    it('returns close level proximity at 0 for price 100', () => {
      const prox = levelProximity(100, levels);
      expect(prox).not.toBeNull();
      expect(prox?.level).toBe('close');
      expect(prox?.price).toBe(100);
      expect(prox?.distanceAtr).toBeCloseTo(0);
      expect(prox?.near).toBe(true);
    });

    it('returns null for non-positive or non-finite prices', () => {
      expect(levelProximity(0, levels)).toBeNull();
      expect(levelProximity(-10, levels)).toBeNull();
      expect(levelProximity(NaN, levels)).toBeNull();
      expect(levelProximity(Infinity, levels)).toBeNull();
    });

    it('returns near: false when price is exactly 10 ATR from every level', () => {
      // 10 ATR = 200 distance. With high=110, price = 310 gives distance 200 (10 ATR).
      // low=90 is 220 (11 ATR), close=100 is 210 (10.5 ATR).
      const prox = levelProximity(310, levels);
      expect(prox).not.toBeNull();
      expect(prox?.level).toBe('high');
      expect(prox?.distanceAtr).toBeCloseTo(10);
      expect(prox?.near).toBe(false);
    });
  });

  describe('levelLabel', () => {
    it('returns human-readable label for each level name', () => {
      expect(levelLabel('high')).toBe('Prev high');
      expect(levelLabel('low')).toBe('Prev low');
      expect(levelLabel('close')).toBe('Prev close');
    });
  });
});
