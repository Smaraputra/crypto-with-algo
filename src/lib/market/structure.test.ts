import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@/types/market';
import {
  analyzeStructure,
  findPivots,
  INTERNAL_LENGTH,
  SWING_LENGTH,
} from './structure';

function makeCandles(
  bars: Array<{ high: number; low: number; close: number; open?: number }>
): OHLCV[] {
  let prevClose = bars[0]?.close ?? 100;
  return bars.map((b, i) => {
    const open = b.open ?? (i === 0 ? b.close : prevClose);
    prevClose = b.close;
    return {
      timestamp: i * 3_600_000,
      open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: 1000,
    };
  });
}

function generateWalk(numBars: number, seed: number): OHLCV[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };

  const candles: OHLCV[] = [];
  let prevClose = 1000;
  for (let i = 0; i < numBars; i++) {
    const change = (rand() - 0.49) * 20;
    const open = prevClose;
    const close = Math.round((open + change) * 100) / 100;
    const maxOC = Math.max(open, close);
    const minOC = Math.min(open, close);
    const high = Math.round((maxOC + rand() * 10) * 100) / 100;
    const low = Math.round((minOC - rand() * 10) * 100) / 100;
    prevClose = close;
    candles.push({
      timestamp: i * 3_600_000,
      open,
      high,
      low,
      close,
      volume: 1000 + Math.floor(rand() * 500),
    });
  }
  return candles;
}

describe('structure', () => {
  it('exports default length constants', () => {
    expect(INTERNAL_LENGTH).toBe(5);
    expect(SWING_LENGTH).toBe(20);
  });

  describe('findPivots', () => {
    it('finds exactly one pivot low on a V shape with length 2 and confirmedIndex = index + 2', () => {
      const candles = makeCandles([
        { high: 100, low: 90, close: 95 },
        { high: 90, low: 70, close: 75 },
        { high: 75, low: 40, close: 50 }, // Bottom at index 2
        { high: 80, low: 60, close: 70 },
        { high: 95, low: 80, close: 85 },
      ]);

      const pivots = findPivots(candles, 2);
      expect(pivots).toHaveLength(1);
      expect(pivots[0]).toEqual({
        kind: 'low',
        index: 2,
        timestamp: 2 * 3_600_000,
        price: 40,
        confirmedIndex: 4,
        label: null,
      });
    });

    it('produces no pivot high for equal adjacent highs', () => {
      const candles = makeCandles([
        { high: 80, low: 70, close: 75 },
        { high: 90, low: 80, close: 85 },
        { high: 100, low: 85, close: 95 }, // Equal high at 2
        { high: 100, low: 85, close: 95 }, // Equal high at 3
        { high: 90, low: 80, close: 85 },
        { high: 80, low: 70, close: 75 },
      ]);

      const pivots = findPivots(candles, 2);
      const highs = pivots.filter((p) => p.kind === 'high');
      expect(highs).toHaveLength(0);
    });

    it('produces no pivots within length bars of either end', () => {
      // 7 bars, indices 0..6. With length 2, only indices 2, 3, 4 can be pivots.
      const candles = makeCandles([
        { high: 1000, low: 900, close: 950 }, // index 0 (within length)
        { high: 999, low: 900, close: 950 },  // index 1 (within length)
        { high: 100, low: 50, close: 70 },    // index 2
        { high: 100, low: 50, close: 70 },    // index 3
        { high: 100, low: 50, close: 70 },    // index 4
        { high: 999, low: 900, close: 950 },  // index 5 (within length)
        { high: 1000, low: 900, close: 950 }, // index 6 (within length)
      ]);

      const pivots = findPivots(candles, 2);
      for (const p of pivots) {
        expect(p.index).toBeGreaterThanOrEqual(2);
        expect(p.index).toBeLessThanOrEqual(4);
      }
    });

    it('assigns HH and HL labels on a rising zigzag', () => {
      const candles = makeCandles([
        { high: 60, low: 50, close: 55 },
        { high: 52, low: 40, close: 45 },   // Low 1 (40) at index 1
        { high: 70, low: 50, close: 65 },
        { high: 100, low: 70, close: 95 },  // High 1 (100) at index 3
        { high: 85, low: 60, close: 70 },
        { high: 65, low: 50, close: 55 },   // Low 2 (50) at index 5
        { high: 85, low: 60, close: 80 },
        { high: 120, low: 80, close: 115 }, // High 2 (120) at index 7
        { high: 100, low: 75, close: 85 },
        { high: 80, low: 60, close: 65 },   // Low 3 (60) at index 9
        { high: 105, low: 75, close: 100 },
        { high: 140, low: 100, close: 135 }, // High 3 (140) at index 11
        { high: 110, low: 85, close: 90 },
      ]);

      const pivots = findPivots(candles, 1);
      const highs = pivots.filter((p) => p.kind === 'high');
      const lows = pivots.filter((p) => p.kind === 'low');

      expect(highs.map((h) => h.label)).toEqual([null, 'HH', 'HH']);
      expect(lows.map((l) => l.label)).toEqual([null, 'HL', 'HL']);
    });

    it('assigns LH and LL labels on a falling zigzag', () => {
      const candles = makeCandles([
        { high: 150, low: 130, close: 140 },
        { high: 160, low: 135, close: 150 }, // High 1 (160) at index 1
        { high: 130, low: 110, close: 120 },
        { high: 115, low: 90, close: 100 },  // Low 1 (90) at index 3
        { high: 125, low: 100, close: 115 },
        { high: 140, low: 110, close: 125 }, // High 2 (140) at index 5
        { high: 110, low: 90, close: 95 },
        { high: 95, low: 70, close: 80 },    // Low 2 (70) at index 7
        { high: 105, low: 80, close: 90 },
        { high: 120, low: 85, close: 100 },  // High 3 (120) at index 9
        { high: 90, low: 70, close: 75 },
        { high: 75, low: 50, close: 60 },    // Low 3 (50) at index 11
        { high: 70, low: 55, close: 65 },
      ]);

      const pivots = findPivots(candles, 1);
      const highs = pivots.filter((p) => p.kind === 'high');
      const lows = pivots.filter((p) => p.kind === 'low');

      expect(highs.map((h) => h.label)).toEqual([null, 'LH', 'LH']);
      expect(lows.map((l) => l.label)).toEqual([null, 'LL', 'LL']);
    });

    it('throws on length 0 and on 2.5', () => {
      const candles = makeCandles([
        { high: 10, low: 5, close: 8 },
        { high: 12, low: 6, close: 10 },
        { high: 11, low: 7, close: 9 },
      ]);

      expect(() => findPivots(candles, 0)).toThrow();
      expect(() => findPivots(candles, 2.5)).toThrow();
    });
  });

  describe('analyzeStructure', () => {
    it('emits BOS bull, CHoCH bear, and BOS bear in sequence', () => {
      const candles = makeCandles([
        { high: 90, low: 80, close: 85 },  // index 0
        { high: 100, low: 85, close: 90 }, // index 1: Pivot high (100), confirmed at 2
        { high: 95, low: 85, close: 90 },  // index 2
        { high: 110, low: 88, close: 105 }, // index 3: Breaks 100 -> BOS bull (from trend 0)
        { high: 95, low: 70, close: 75 },  // index 4: Pivot low (70), confirmed at 5
        { high: 90, low: 80, close: 85 },  // index 5
        { high: 80, low: 60, close: 65 },  // index 6: Breaks 70 -> CHoCH bear (from trend 1)
        { high: 75, low: 50, close: 55 },  // index 7: Pivot low (50), confirmed at 8
        { high: 65, low: 55, close: 60 },  // index 8
        { high: 55, low: 40, close: 45 },  // index 9: Breaks 50 -> BOS bear (from trend -1)
        { high: 50, low: 42, close: 48 },  // index 10
      ]);

      const result = analyzeStructure(candles, 1);
      expect(result.events).toHaveLength(3);

      expect(result.events[0]).toEqual({
        type: 'BOS',
        direction: 'bull',
        level: 100,
        pivotIndex: 1,
        breakIndex: 3,
        breakTimestamp: 3 * 3_600_000,
      });

      expect(result.events[1]).toEqual({
        type: 'CHoCH',
        direction: 'bear',
        level: 70,
        pivotIndex: 4,
        breakIndex: 6,
        breakTimestamp: 6 * 3_600_000,
      });

      expect(result.events[2]).toEqual({
        type: 'BOS',
        direction: 'bear',
        level: 50,
        pivotIndex: 7,
        breakIndex: 9,
        breakTimestamp: 9 * 3_600_000,
      });

      expect(result.trend).toBe(-1);
    });

    it('does not break when close equals the pivot level or wicks beyond without close beyond', () => {
      const candles = makeCandles([
        { high: 90, low: 80, close: 85 },  // index 0
        { high: 100, low: 80, close: 90 }, // index 1: Pivot high (100), confirmed at 2
        { high: 95, low: 80, close: 90 },  // index 2
        { high: 105, low: 80, close: 100 }, // index 3: Close equals 100 (not greater)
        { high: 108, low: 80, close: 98 },  // index 4: Wick 108 reaches beyond, close 98 is below
      ]);

      const result = analyzeStructure(candles, 1);
      expect(result.events).toHaveLength(0);
      expect(result.trend).toBe(0);
    });

    it('does not break a broken pivot again on the next bar', () => {
      const candles = makeCandles([
        { high: 90, low: 80, close: 85 },  // index 0
        { high: 100, low: 80, close: 90 }, // index 1: Pivot high (100), confirmed at 2
        { high: 95, low: 80, close: 90 },  // index 2
        { high: 106, low: 80, close: 105 }, // index 3: Breaks 100 -> BOS bull
        { high: 112, low: 80, close: 110 }, // index 4: Still above 100, but already broken
        { high: 95, low: 80, close: 90 },  // index 5
      ]);

      const result = analyzeStructure(candles, 1);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].breakIndex).toBe(3);
    });

    it('throws on length 0 and on 2.5', () => {
      const candles = makeCandles([
        { high: 10, low: 5, close: 8 },
        { high: 12, low: 6, close: 10 },
        { high: 11, low: 7, close: 9 },
      ]);

      expect(() => analyzeStructure(candles, 0)).toThrow();
      expect(() => analyzeStructure(candles, 2.5)).toThrow();
    });

    it('does not repaint across a 120-bar pseudo-random walk', () => {
      const candles = generateWalk(120, 42);
      const length = 3;
      const full = analyzeStructure(candles, length);

      for (let t = 0; t < candles.length; t++) {
        const slice = analyzeStructure(candles.slice(0, t + 1), length);
        const expectedPivots = full.pivots.filter((p) => p.confirmedIndex <= t);
        const expectedEvents = full.events.filter((e) => e.breakIndex <= t);

        expect(slice.pivots).toEqual(expectedPivots);
        expect(slice.events).toEqual(expectedEvents);
      }
    });
  });
});
