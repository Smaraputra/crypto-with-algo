import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@/types/market';
import { findPivots, type Pivot } from '@/lib/market/structure';
import {
  barDelta,
  barWinner,
  CVD_SLOPE_BARS,
  cvdSeries,
  cvdSlope,
  DIVERGENCE_MAX_BARS,
  deltaDivergences,
  type CvdPoint,
} from './delta';

function makeCandle(opts: {
  timestamp?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume: number;
  takerBuyVolume?: number;
}): OHLCV {
  return {
    timestamp: opts.timestamp ?? 0,
    open: opts.open ?? 100,
    high: opts.high ?? 105,
    low: opts.low ?? 95,
    close: opts.close ?? 100,
    volume: opts.volume,
    takerBuyVolume: opts.takerBuyVolume,
  };
}

describe('delta', () => {
  it('exports default constants', () => {
    expect(CVD_SLOPE_BARS).toBe(20);
    expect(DIVERGENCE_MAX_BARS).toBe(72);
  });

  describe('barDelta and barWinner', () => {
    it('takerBuy 6 of volume 10 gives 2 and winner buy', () => {
      const candle = makeCandle({ volume: 10, takerBuyVolume: 6 });
      expect(barDelta(candle)).toBe(2);
      expect(barWinner(candle)).toBe('buy');
    });

    it('takerBuy 5 of volume 10 gives 0 and winner even', () => {
      const candle = makeCandle({ volume: 10, takerBuyVolume: 5 });
      expect(barDelta(candle)).toBe(0);
      expect(barWinner(candle)).toBe('even');
    });

    it('takerBuy 4 of volume 10 gives -2 and winner sell', () => {
      const candle = makeCandle({ volume: 10, takerBuyVolume: 4 });
      expect(barDelta(candle)).toBe(-2);
      expect(barWinner(candle)).toBe('sell');
    });

    it('missing takerBuyVolume gives null and winner null', () => {
      const candle = makeCandle({ volume: 10 });
      expect(barDelta(candle)).toBeNull();
      expect(barWinner(candle)).toBeNull();
    });

    it('non-finite volume or takerBuyVolume gives null', () => {
      expect(barDelta(makeCandle({ volume: Number.NaN, takerBuyVolume: 5 }))).toBeNull();
      expect(barDelta(makeCandle({ volume: 10, takerBuyVolume: Number.NaN }))).toBeNull();
      expect(barDelta(makeCandle({ volume: Number.POSITIVE_INFINITY, takerBuyVolume: 5 }))).toBeNull();
    });
  });

  describe('cvdSeries', () => {
    it('with resetDaily: 1h bars across a UTC midnight restarts the sum at its own delta', () => {
      const dayMs = 86_400_000;
      const candles: OHLCV[] = [
        makeCandle({ timestamp: dayMs - 2 * 3_600_000, volume: 10, takerBuyVolume: 7 }), // 22:00 -> delta = 4
        makeCandle({ timestamp: dayMs - 1 * 3_600_000, volume: 10, takerBuyVolume: 8 }), // 23:00 -> delta = 6 (cvd = 10)
        makeCandle({ timestamp: dayMs, volume: 10, takerBuyVolume: 6 }), // 00:00 midnight -> delta = 2 (cvd restarts at 2)
        makeCandle({ timestamp: dayMs + 1 * 3_600_000, volume: 10, takerBuyVolume: 7 }), // 01:00 -> delta = 4 (cvd = 6)
      ];

      const points = cvdSeries(candles, { resetDaily: true });
      expect(points).toEqual([
        { timestamp: dayMs - 2 * 3_600_000, cvd: 4, reset: false },
        { timestamp: dayMs - 1 * 3_600_000, cvd: 10, reset: false },
        { timestamp: dayMs, cvd: 2, reset: true },
        { timestamp: dayMs + 1 * 3_600_000, cvd: 6, reset: false },
      ]);
    });

    it('without reset: the sum is continuous across UTC midnight', () => {
      const dayMs = 86_400_000;
      const candles: OHLCV[] = [
        makeCandle({ timestamp: dayMs - 2 * 3_600_000, volume: 10, takerBuyVolume: 7 }), // 22:00 -> delta = 4
        makeCandle({ timestamp: dayMs - 1 * 3_600_000, volume: 10, takerBuyVolume: 8 }), // 23:00 -> delta = 6 (cvd = 10)
        makeCandle({ timestamp: dayMs, volume: 10, takerBuyVolume: 6 }), // 00:00 -> delta = 2 (cvd = 12)
        makeCandle({ timestamp: dayMs + 1 * 3_600_000, volume: 10, takerBuyVolume: 7 }), // 01:00 -> delta = 4 (cvd = 16)
      ];

      const points = cvdSeries(candles, { resetDaily: false });
      expect(points).toEqual([
        { timestamp: dayMs - 2 * 3_600_000, cvd: 4, reset: false },
        { timestamp: dayMs - 1 * 3_600_000, cvd: 10, reset: false },
        { timestamp: dayMs, cvd: 12, reset: false },
        { timestamp: dayMs + 1 * 3_600_000, cvd: 16, reset: false },
      ]);
    });

    it('a null delta gives a null point, and the next point continues from the last non-null sum', () => {
      const candles: OHLCV[] = [
        makeCandle({ timestamp: 3_600_000, volume: 10, takerBuyVolume: 7 }), // delta = 4 -> cvd = 4
        makeCandle({ timestamp: 2 * 3_600_000, volume: 10 }), // missing taker -> cvd = null
        makeCandle({ timestamp: 3 * 3_600_000, volume: 10, takerBuyVolume: 8 }), // delta = 6 -> cvd = 10
        makeCandle({ timestamp: 4 * 3_600_000, volume: 10, takerBuyVolume: 4 }), // delta = -2 -> cvd = 8
      ];

      const points = cvdSeries(candles, { resetDaily: false });
      expect(points).toEqual([
        { timestamp: 3_600_000, cvd: 4, reset: false },
        { timestamp: 2 * 3_600_000, cvd: null, reset: false },
        { timestamp: 3 * 3_600_000, cvd: 10, reset: false },
        { timestamp: 4 * 3_600_000, cvd: 8, reset: false },
      ]);
    });

    it('marks reset: true only on midnight bars with resetDaily, and never on the first point', () => {
      const dayMs = 86_400_000;
      const candles: OHLCV[] = [
        makeCandle({ timestamp: 0, volume: 10, takerBuyVolume: 6 }), // 00:00 midnight (first point) -> reset false
        makeCandle({ timestamp: 3_600_000, volume: 10, takerBuyVolume: 6 }), // 01:00 -> reset false
        makeCandle({ timestamp: dayMs, volume: 10, takerBuyVolume: 6 }), // 00:00 next midnight -> reset true
        makeCandle({ timestamp: dayMs + 3_600_000, volume: 10, takerBuyVolume: 6 }), // 01:00 -> reset false
      ];

      const withReset = cvdSeries(candles, { resetDaily: true });
      expect(withReset[0].reset).toBe(false);
      expect(withReset[1].reset).toBe(false);
      expect(withReset[2].reset).toBe(true);
      expect(withReset[3].reset).toBe(false);

      const withoutReset = cvdSeries(candles, { resetDaily: false });
      expect(withoutReset[0].reset).toBe(false);
      expect(withoutReset[1].reset).toBe(false);
      expect(withoutReset[2].reset).toBe(false);
      expect(withoutReset[3].reset).toBe(false);
    });
  });

  describe('cvdSlope', () => {
    it('detects rising, falling, and flat cases within the same day', () => {
      // 21 points on day 1 (01:00 through 21:00)
      const basePoints = (deltas: number[]): CvdPoint[] => {
        return deltas.map((cvd, i) => ({
          timestamp: (i + 1) * 3_600_000,
          cvd,
          reset: false,
        }));
      };

      // 21 points for 20-bar slope
      const risingDeltas = Array.from({ length: 21 }, (_, i) => i * 10); // cvd[20] = 200 > cvd[0] = 0
      expect(cvdSlope(basePoints(risingDeltas), 20)).toBe('rising');

      const fallingDeltas = Array.from({ length: 21 }, (_, i) => 200 - i * 10); // cvd[20] = 0 < cvd[0] = 200
      expect(cvdSlope(basePoints(fallingDeltas), 20)).toBe('falling');

      const flatDeltas = Array.from({ length: 21 }, () => 50); // cvd[20] === cvd[0]
      expect(cvdSlope(basePoints(flatDeltas), 20)).toBe('flat');
    });

    it('returns null when a reset lies inside the window with resetDaily', () => {
      const dayMs = 86_400_000;
      // 25 bars crossing midnight (e.g. from 12:00 Day 0 to 12:00 Day 1)
      const startMs = dayMs - 12 * 3_600_000;
      const candles: OHLCV[] = Array.from({ length: 25 }, (_, i) =>
        makeCandle({
          timestamp: startMs + i * 3_600_000,
          volume: 10,
          takerBuyVolume: 6,
        })
      );

      const points = cvdSeries(candles, { resetDaily: true });
      expect(cvdSlope(points, 20)).toBeNull();
    });

    it('a resetDaily: false series of 1h bars spanning 3 UTC days gives a non-null slope over 20 bars, rising for positive deltas', () => {
      const dayMs = 86_400_000;
      // 72 1h bars spanning 3 full days (from 12:00 Day 1 to 11:00 Day 4)
      const startMs = dayMs + 12 * 3_600_000;
      const candles: OHLCV[] = Array.from({ length: 72 }, (_, i) =>
        makeCandle({
          timestamp: startMs + i * 3_600_000,
          volume: 10,
          takerBuyVolume: 7, // positive delta: 2 * 7 - 10 = +4 each bar
        })
      );

      const points = cvdSeries(candles, { resetDaily: false });
      // The last 20 bars start at 15:00 Day 3 and end at 11:00 Day 4, crossing midnight Day 4 (00:00)
      const slope = cvdSlope(points, 20);
      expect(slope).toBe('rising');
    });

    it('a resetDaily: true series with a midnight bar inside the window gives null, while the same series with the window entirely after the midnight bar gives a slope', () => {
      const dayMs = 86_400_000;
      // Start 5 hours before midnight: Day 0 19:00 to Day 1 21:00 (27 bars)
      // Index 5 is 00:00 midnight (Day 1)
      const startMs = dayMs - 5 * 3_600_000;
      const candles: OHLCV[] = Array.from({ length: 27 }, (_, i) =>
        makeCandle({
          timestamp: startMs + i * 3_600_000,
          volume: 10,
          takerBuyVolume: 6, // positive delta = 2
        })
      );

      const points = cvdSeries(candles, { resetDaily: true });
      expect(points[5].timestamp).toBe(dayMs);
      expect(points[5].reset).toBe(true);

      // Window of 20 bars covering indices 0 to 20: includes index 5 (midnight bar with reset: true)
      const windowAcrossReset = points.slice(0, 21);
      expect(cvdSlope(windowAcrossReset, 20)).toBeNull();

      // Window of 20 bars covering indices 6 to 26: entirely after index 5
      // With period 20 on full series of 27 bars (lastIdx = 26, firstIdx = 6), index 5 is before firstIdx
      expect(cvdSlope(points, 20)).toBe('rising');
    });

    it('returns null with too few points', () => {
      const points: CvdPoint[] = [
        { timestamp: 3_600_000, cvd: 10, reset: false },
        { timestamp: 2 * 3_600_000, cvd: 20, reset: false },
      ];
      expect(cvdSlope(points, 20)).toBeNull();
      expect(cvdSlope(points, 2)).toBeNull(); // 2 points is < 2 + 1
    });

    it('returns null if either endpoint has null cvd', () => {
      const points: CvdPoint[] = [
        { timestamp: 3_600_000, cvd: null, reset: false },
        { timestamp: 2 * 3_600_000, cvd: 10, reset: false },
        { timestamp: 3 * 3_600_000, cvd: 20, reset: false },
      ];
      expect(cvdSlope(points, 2)).toBeNull();

      const points2: CvdPoint[] = [
        { timestamp: 3_600_000, cvd: 10, reset: false },
        { timestamp: 2 * 3_600_000, cvd: 20, reset: false },
        { timestamp: 3 * 3_600_000, cvd: null, reset: false },
      ];
      expect(cvdSlope(points2, 2)).toBeNull();
    });
  });

  describe('deltaDivergences', () => {
    it('covers all four divergence cases with hand-built pivots', () => {
      // Common candles container of 10 bars
      // Case 1: highs, regular bear: second.price > first.price and summedDelta < 0
      const candlesRegularBear: OHLCV[] = Array.from({ length: 10 }, (_, i) =>
        makeCandle({
          timestamp: i * 3_600_000,
          volume: 10,
          takerBuyVolume: 2, // delta = 2*2 - 10 = -6 each bar
        })
      );
      const highPivot1: Pivot = {
        kind: 'high',
        index: 2,
        timestamp: 2 * 3_600_000,
        price: 100,
        confirmedIndex: 4,
        label: null,
      };
      const highPivot2: Pivot = {
        kind: 'high',
        index: 5,
        timestamp: 5 * 3_600_000,
        price: 110, // higher price
        confirmedIndex: 7,
        label: 'HH',
      };

      const regularBear = deltaDivergences(candlesRegularBear, [highPivot1, highPivot2]);
      expect(regularBear).toHaveLength(1);
      expect(regularBear[0]).toEqual({
        kind: 'regular',
        direction: 'bear',
        first: highPivot1,
        second: highPivot2,
        summedDelta: -18, // 3 bars (indices 3, 4, 5) * -6
        confirmedIndex: 7,
      });

      // Case 2: highs, hidden bear: second.price < first.price and summedDelta > 0
      const candlesHiddenBear: OHLCV[] = Array.from({ length: 10 }, (_, i) =>
        makeCandle({
          timestamp: i * 3_600_000,
          volume: 10,
          takerBuyVolume: 8, // delta = 2*8 - 10 = +6 each bar
        })
      );
      const highPivot3: Pivot = {
        kind: 'high',
        index: 5,
        timestamp: 5 * 3_600_000,
        price: 90, // lower price
        confirmedIndex: 7,
        label: 'LH',
      };

      const hiddenBear = deltaDivergences(candlesHiddenBear, [highPivot1, highPivot3]);
      expect(hiddenBear).toHaveLength(1);
      expect(hiddenBear[0]).toEqual({
        kind: 'hidden',
        direction: 'bear',
        first: highPivot1,
        second: highPivot3,
        summedDelta: 18,
        confirmedIndex: 7,
      });

      // Case 3: lows, regular bull: second.price < first.price and summedDelta > 0
      const lowPivot1: Pivot = {
        kind: 'low',
        index: 2,
        timestamp: 2 * 3_600_000,
        price: 50,
        confirmedIndex: 4,
        label: null,
      };
      const lowPivot2: Pivot = {
        kind: 'low',
        index: 5,
        timestamp: 5 * 3_600_000,
        price: 40, // lower price
        confirmedIndex: 7,
        label: 'LL',
      };

      const regularBull = deltaDivergences(candlesHiddenBear, [lowPivot1, lowPivot2]);
      expect(regularBull).toHaveLength(1);
      expect(regularBull[0]).toEqual({
        kind: 'regular',
        direction: 'bull',
        first: lowPivot1,
        second: lowPivot2,
        summedDelta: 18,
        confirmedIndex: 7,
      });

      // Case 4: lows, hidden bull: second.price > first.price and summedDelta < 0
      const lowPivot3: Pivot = {
        kind: 'low',
        index: 5,
        timestamp: 5 * 3_600_000,
        price: 60, // higher price
        confirmedIndex: 7,
        label: 'HL',
      };

      const hiddenBull = deltaDivergences(candlesRegularBear, [lowPivot1, lowPivot3]);
      expect(hiddenBull).toHaveLength(1);
      expect(hiddenBull[0]).toEqual({
        kind: 'hidden',
        direction: 'bull',
        first: lowPivot1,
        second: lowPivot3,
        summedDelta: -18,
        confirmedIndex: 7,
      });
    });

    it('skips pairs further apart than maxBars', () => {
      const candles: OHLCV[] = Array.from({ length: 80 }, (_, i) =>
        makeCandle({
          timestamp: i * 3_600_000,
          volume: 10,
          takerBuyVolume: 2,
        })
      );
      const p1: Pivot = {
        kind: 'high',
        index: 2,
        timestamp: 2 * 3_600_000,
        price: 100,
        confirmedIndex: 4,
        label: null,
      };
      const p2: Pivot = {
        kind: 'high',
        index: 76, // 76 - 2 = 74 > DIVERGENCE_MAX_BARS (72)
        timestamp: 76 * 3_600_000,
        price: 110,
        confirmedIndex: 78,
        label: 'HH',
      };

      expect(deltaDivergences(candles, [p1, p2])).toHaveLength(0);

      // Also custom maxBars
      const pNear: Pivot = {
        kind: 'high',
        index: 8, // 8 - 2 = 6
        timestamp: 8 * 3_600_000,
        price: 110,
        confirmedIndex: 10,
        label: 'HH',
      };
      expect(deltaDivergences(candles, [p1, pNear], 5)).toHaveLength(0);
      expect(deltaDivergences(candles, [p1, pNear], 6)).toHaveLength(1);
    });

    it('skips pair when any barDelta inside the range is missing', () => {
      const candles: OHLCV[] = Array.from({ length: 10 }, (_, i) =>
        makeCandle({
          timestamp: i * 3_600_000,
          volume: 10,
          takerBuyVolume: i === 4 ? undefined : 2, // missing at index 4
        })
      );
      const p1: Pivot = {
        kind: 'high',
        index: 2,
        timestamp: 2 * 3_600_000,
        price: 100,
        confirmedIndex: 4,
        label: null,
      };
      const p2: Pivot = {
        kind: 'high',
        index: 5,
        timestamp: 5 * 3_600_000,
        price: 110,
        confirmedIndex: 7,
        label: 'HH',
      };

      expect(deltaDivergences(candles, [p1, p2])).toHaveLength(0);
    });

    it('pairs only consecutive pivots of the same kind, not first-to-third', () => {
      // 3 high pivots:
      // p1 at 2 (price 100)
      // p2 at 4 (price 105)
      // p3 at 6 (price 110)
      // Between p1 and p2: deltas are positive (price up, delta up -> no divergence)
      // Between p2 and p3: deltas are positive (price up, delta up -> no divergence)
      // Between p1 and p3: deltas would not be paired because they are not consecutive!
      const candles: OHLCV[] = Array.from({ length: 10 }, (_, i) =>
        makeCandle({
          timestamp: i * 3_600_000,
          volume: 10,
          takerBuyVolume: 8, // delta = +6 each bar
        })
      );
      const p1: Pivot = {
        kind: 'high',
        index: 2,
        timestamp: 2 * 3_600_000,
        price: 100,
        confirmedIndex: 3,
        label: null,
      };
      const p2: Pivot = {
        kind: 'high',
        index: 4,
        timestamp: 4 * 3_600_000,
        price: 105,
        confirmedIndex: 5,
        label: 'HH',
      };
      const p3: Pivot = {
        kind: 'high',
        index: 6,
        timestamp: 6 * 3_600_000,
        price: 110,
        confirmedIndex: 7,
        label: 'HH',
      };

      expect(deltaDivergences(candles, [p1, p2, p3])).toHaveLength(0);
    });

    it('gives nothing for equal prices or zero summedDelta', () => {
      const candlesZeroDelta: OHLCV[] = Array.from({ length: 10 }, (_, i) =>
        makeCandle({
          timestamp: i * 3_600_000,
          volume: 10,
          takerBuyVolume: 5, // delta = 0
        })
      );
      const p1: Pivot = {
        kind: 'high',
        index: 2,
        timestamp: 2 * 3_600_000,
        price: 100,
        confirmedIndex: 4,
        label: null,
      };
      const p2: Pivot = {
        kind: 'high',
        index: 5,
        timestamp: 5 * 3_600_000,
        price: 110,
        confirmedIndex: 7,
        label: 'HH',
      };
      expect(deltaDivergences(candlesZeroDelta, [p1, p2])).toHaveLength(0);

      const pEqualPrice: Pivot = {
        kind: 'high',
        index: 5,
        timestamp: 5 * 3_600_000,
        price: 100,
        confirmedIndex: 7,
        label: null,
      };
      const candlesNegDelta: OHLCV[] = Array.from({ length: 10 }, (_, i) =>
        makeCandle({
          timestamp: i * 3_600_000,
          volume: 10,
          takerBuyVolume: 2,
        })
      );
      expect(deltaDivergences(candlesNegDelta, [p1, pEqualPrice])).toHaveLength(0);
    });

    it('integration: runs findPivots from structure.ts with length 2 and detects regular bear divergence', () => {
      // Construct a candle series with 2 swing highs at length 2:
      // High 1 at index 2 (high 100), surrounded by 2 bars on each side with high < 100
      // High 2 at index 7 (high 110), surrounded by 2 bars on each side with high < 110
      // Bars (2, 7] have aggressive taker sells so summedDelta < 0
      const highs = [80, 85, 100, 88, 85, 87, 95, 110, 90, 85];
      const lows = [70, 75, 90, 80, 75, 78, 85, 100, 80, 75];
      const candles: OHLCV[] = highs.map((h, i) => {
        return makeCandle({
          timestamp: i * 3_600_000,
          open: lows[i] + 5,
          high: h,
          low: lows[i],
          close: lows[i] + 7,
          volume: 10,
          // Aggressive taker sellers during (2, 7]: takerBuy = 2 (delta = -6)
          takerBuyVolume: 2,
        });
      });

      const pivots = findPivots(candles, 2);
      const highPivots = pivots.filter((p) => p.kind === 'high');
      expect(highPivots).toHaveLength(2);
      expect(highPivots[0].index).toBe(2);
      expect(highPivots[0].price).toBe(100);
      expect(highPivots[1].index).toBe(7);
      expect(highPivots[1].price).toBe(110);

      const divergences = deltaDivergences(candles, pivots);
      expect(divergences).toHaveLength(1);
      expect(divergences[0]).toEqual({
        kind: 'regular',
        direction: 'bear',
        first: highPivots[0],
        second: highPivots[1],
        summedDelta: -30, // 5 bars (indices 3..7) * -6
        confirmedIndex: 9, // index 7 + length 2
      });
    });
  });
});
