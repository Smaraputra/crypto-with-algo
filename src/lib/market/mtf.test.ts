import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@/types/market';
import {
  closedBars,
  mtfState,
  MTF_INTERVAL_MS,
  MTF_INTERVALS,
  MTF_SMA_LENGTH,
} from './mtf';

function makeCandle(opts: {
  timestamp: number;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
  takerBuyVolume?: number;
}): OHLCV {
  const close = opts.close;
  const open = opts.open ?? close;
  const high = opts.high ?? Math.max(open, close);
  const low = opts.low ?? Math.min(open, close);
  return {
    timestamp: opts.timestamp,
    open,
    high,
    low,
    close,
    volume: opts.volume ?? 1000,
    takerBuyVolume: opts.takerBuyVolume,
  };
}

describe('mtf', () => {
  it('exports expected constants', () => {
    expect(MTF_INTERVALS).toEqual(['15m', '1h', '4h', '1d']);
    expect(MTF_SMA_LENGTH).toBe(50);
    expect(MTF_INTERVAL_MS).toEqual({
      '15m': 900_000,
      '1h': 3_600_000,
      '4h': 14_400_000,
      '1d': 86_400_000,
    });
  });

  describe('closedBars', () => {
    it('drops a forming last bar and keeps a bar that closes exactly at nowMs', () => {
      const interval = '15m';
      const intervalMs = MTF_INTERVAL_MS[interval]; // 900_000

      const bar0 = makeCandle({ timestamp: 0, close: 100 });
      const bar1 = makeCandle({ timestamp: intervalMs, close: 101 }); // closes at 1_800_000
      const bar2 = makeCandle({ timestamp: 2 * intervalMs, close: 102 }); // closes at 2_700_000

      const candles = [bar0, bar1, bar2];

      // At exactly 1_800_000: bar0 and bar1 have closed, bar2 is forming
      const resultAtClose = closedBars(candles, interval, 2 * intervalMs);
      expect(resultAtClose).toHaveLength(2);
      expect(resultAtClose[0].timestamp).toBe(0);
      expect(resultAtClose[1].timestamp).toBe(intervalMs);

      // 1 ms before bar1 closes: only bar0 is closed
      const resultBeforeClose = closedBars(candles, interval, 2 * intervalMs - 1);
      expect(resultBeforeClose).toHaveLength(1);
      expect(resultBeforeClose[0].timestamp).toBe(0);
    });

    it('returns empty array when given empty candles or when all bars are forming', () => {
      expect(closedBars([], '1h', 10_000_000)).toEqual([]);

      const bar = makeCandle({ timestamp: 1_000_000, close: 100 });
      expect(closedBars([bar], '1h', 1_000_000 + 3_600_000 - 1)).toEqual([]);
    });

    it('preserves bar order and works across all MTF intervals', () => {
      for (const interval of MTF_INTERVALS) {
        const step = MTF_INTERVAL_MS[interval];
        const candles = [
          makeCandle({ timestamp: 0, close: 10 }),
          makeCandle({ timestamp: step, close: 20 }),
          makeCandle({ timestamp: 2 * step, close: 30 }),
        ];
        const closed = closedBars(candles, interval, 3 * step);
        expect(closed.map((c) => c.timestamp)).toEqual([0, step, 2 * step]);
      }
    });
  });

  describe('mtfState', () => {
    it('on a long rising zigzag (enough bars for swing length 20), trend 1, lastEvent a bull event, priceVsSma above', () => {
      const interval = '15m';
      const step = MTF_INTERVAL_MS[interval];
      const candles: OHLCV[] = [];

      // 65 bars total
      for (let i = 0; i < 65; i++) {
        const timestamp = (i + 1) * step; // within first day
        if (i < 20) {
          candles.push(makeCandle({ timestamp, high: 105, low: 95, close: 100 }));
        } else if (i === 20) {
          // Pivot high at index 20 (high: 150)
          candles.push(makeCandle({ timestamp, high: 150, low: 95, close: 120 }));
        } else if (i < 41) {
          // Bars 21..40 keep highs < 150 to confirm pivot at index 20 (confirmed at index 40)
          candles.push(makeCandle({ timestamp, high: 105, low: 95, close: 100 }));
        } else if (i === 45) {
          // Breakout candle closing above 150 -> BOS bull
          candles.push(makeCandle({ timestamp, high: 170, low: 100, close: 165 }));
        } else if (i > 45) {
          // Continue rising to ensure close is above 50-bar SMA
          candles.push(makeCandle({ timestamp, high: 180 + i, low: 160 + i, close: 175 + i }));
        } else {
          candles.push(makeCandle({ timestamp, high: 105, low: 95, close: 100 }));
        }
      }

      const nowMs = 70 * step;
      const state = mtfState(interval, candles, nowMs);

      expect(state.interval).toBe('15m');
      expect(state.trend).toBe(1);
      expect(state.lastEvent).not.toBeNull();
      expect(state.lastEvent?.direction).toBe('bull');
      expect(state.lastEvent?.level).toBe(150);
      expect(state.priceVsSma).toBe('above');
    });

    it('on the mirror falling zigzag, trend -1, lastEvent a bear event, priceVsSma below', () => {
      const interval = '15m';
      const step = MTF_INTERVAL_MS[interval];
      const candles: OHLCV[] = [];

      // 65 bars total
      for (let i = 0; i < 65; i++) {
        const timestamp = (i + 1) * step;
        if (i < 20) {
          candles.push(makeCandle({ timestamp, high: 205, low: 195, close: 200 }));
        } else if (i === 20) {
          // Pivot low at index 20 (low: 50)
          candles.push(makeCandle({ timestamp, high: 205, low: 50, close: 80 }));
        } else if (i < 41) {
          // Bars 21..40 keep lows > 50 to confirm pivot at index 20 (confirmed at index 40)
          candles.push(makeCandle({ timestamp, high: 205, low: 195, close: 200 }));
        } else if (i === 45) {
          // Breakdown candle closing below 50 -> BOS bear
          candles.push(makeCandle({ timestamp, high: 190, low: 30, close: 35 }));
        } else if (i > 45) {
          // Continue falling to ensure close is below 50-bar SMA
          candles.push(makeCandle({ timestamp, high: 35, low: 10, close: 20 }));
        } else {
          candles.push(makeCandle({ timestamp, high: 205, low: 195, close: 200 }));
        }
      }

      const nowMs = 70 * step;
      const state = mtfState(interval, candles, nowMs);

      expect(state.interval).toBe('15m');
      expect(state.trend).toBe(-1);
      expect(state.lastEvent).not.toBeNull();
      expect(state.lastEvent?.direction).toBe('bear');
      expect(state.lastEvent?.level).toBe(50);
      expect(state.priceVsSma).toBe('below');
    });

    it('with fewer than 50 closed bars, priceVsSma null', () => {
      const interval = '1h';
      const step = MTF_INTERVAL_MS[interval];
      const candles: OHLCV[] = [];

      for (let i = 0; i < 49; i++) {
        candles.push(makeCandle({ timestamp: i * step, close: 100 }));
      }

      const state = mtfState(interval, candles, 50 * step);
      expect(state.priceVsSma).toBeNull();
    });

    it('with no takerBuyVolume, cvdSlope null', () => {
      const interval = '1h';
      const step = MTF_INTERVAL_MS[interval];
      const candles: OHLCV[] = [];

      for (let i = 0; i < 55; i++) {
        candles.push(makeCandle({ timestamp: i * step, close: 100 }));
      }

      const state = mtfState(interval, candles, 60 * step);
      expect(state.cvdSlope).toBeNull();
    });

    it('asOf is the last closed bar timestamp and null when there is none', () => {
      const interval = '15m';
      const step = MTF_INTERVAL_MS[interval];

      const bar0 = makeCandle({ timestamp: 1_000, close: 100 });
      const bar1 = makeCandle({ timestamp: 1_000 + step, close: 101 });
      const bar2 = makeCandle({ timestamp: 1_000 + 2 * step, close: 102 });

      // Only bar0 and bar1 are closed
      const nowMs = 1_000 + 2 * step;
      const state = mtfState(interval, [bar0, bar1, bar2], nowMs);
      expect(state.asOf).toBe(1_000 + step);

      // No closed bars
      const emptyState = mtfState(interval, [], nowMs);
      expect(emptyState.asOf).toBeNull();
      expect(emptyState.trend).toBe(0);
      expect(emptyState.lastEvent).toBeNull();
      expect(emptyState.cvdSlope).toBeNull();
      expect(emptyState.priceVsSma).toBeNull();
    });

    it('a forming bar whose close would flip the SMA side does not change the result', () => {
      const interval = '15m';
      const step = MTF_INTERVAL_MS[interval];
      const candles: OHLCV[] = [];

      // 50 closed bars with close = 100, lastClose = 105 (so priceVsSma is 'above')
      for (let i = 0; i < 49; i++) {
        candles.push(makeCandle({ timestamp: i * step, close: 100 }));
      }
      candles.push(makeCandle({ timestamp: 49 * step, close: 105 }));

      // 51st bar is still forming: its close is 10, which would drag price below SMA if closed
      candles.push(makeCandle({ timestamp: 50 * step, close: 10 }));

      // nowMs is at the open time of the 51st bar (it has not closed yet)
      const nowMs = 50 * step;
      const state = mtfState(interval, candles, nowMs);

      expect(state.asOf).toBe(49 * step);
      expect(state.priceVsSma).toBe('above');
    });

    it('counts equal price vs SMA as above', () => {
      const interval = '1h';
      const step = MTF_INTERVAL_MS[interval];
      const candles: OHLCV[] = [];

      for (let i = 0; i < 50; i++) {
        candles.push(makeCandle({ timestamp: i * step, close: 100 }));
      }

      const state = mtfState(interval, candles, 55 * step);
      expect(state.priceVsSma).toBe('above');
    });

    it('computes cvdSlope correctly when takerBuyVolume is present', () => {
      const interval = '15m';
      const step = MTF_INTERVAL_MS[interval];
      const candles: OHLCV[] = [];

      // Start at 01:00 UTC to stay within the same UTC day
      const baseTimestamp = 3_600_000;
      for (let i = 0; i < 25; i++) {
        candles.push(
          makeCandle({
            timestamp: baseTimestamp + i * step,
            close: 100,
            volume: 1000,
            takerBuyVolume: 800, // positive delta: 2 * 800 - 1000 = 600
          })
        );
      }

      const state = mtfState(interval, candles, baseTimestamp + 30 * step);
      expect(state.cvdSlope).toBe('rising');
    });
  });
});
