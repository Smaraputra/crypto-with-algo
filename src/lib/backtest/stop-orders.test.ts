import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@/types/market';
import { evaluateStopOrder, type PendingStopOrder } from './stop-orders';

const candle = (open: number, high: number, low: number, close: number): OHLCV => ({
  timestamp: 0,
  open,
  high,
  low,
  close,
  volume: 1,
});

const buyStop = (trigger: number, timeoutBars = 1): PendingStopOrder => ({
  legs: [{ side: 'long', triggerPrice: trigger }],
  placedBar: 10,
  timeoutBars,
});

describe('evaluateStopOrder', () => {
  it('never fills on its placement bar', () => {
    expect(evaluateStopOrder(buyStop(100), 10, candle(99, 105, 98, 104))).toEqual({ status: 'pending' });
  });

  it('fills a buy stop on a touch, at the trigger', () => {
    expect(evaluateStopOrder(buyStop(100), 11, candle(99, 100, 98, 99.5))).toEqual({
      status: 'filled',
      leg: 0,
      fillPrice: 100,
      ambiguous: false,
    });
  });

  it('fills at the open, the worse price, when the bar opens through the trigger', () => {
    expect(evaluateStopOrder(buyStop(100), 11, candle(102, 104, 101, 103))).toMatchObject({ fillPrice: 102 });
    const sellStop: PendingStopOrder = { legs: [{ side: 'short', triggerPrice: 100 }], placedBar: 10, timeoutBars: 1 };
    expect(evaluateStopOrder(sellStop, 11, candle(97, 98, 95, 96))).toMatchObject({ fillPrice: 97 });
    expect(evaluateStopOrder(sellStop, 11, candle(101, 102, 99.9, 100))).toMatchObject({ fillPrice: 100 });
  });

  it('expires on its last live bar when untriggered, and stays pending before it', () => {
    expect(evaluateStopOrder(buyStop(100, 3), 11, candle(99, 99.5, 98, 99))).toEqual({ status: 'pending' });
    expect(evaluateStopOrder(buyStop(100, 3), 13, candle(99, 99.5, 98, 99))).toEqual({ status: 'expired' });
    expect(evaluateStopOrder(buyStop(100, 1), 11, candle(99, 99.5, 98, 99))).toEqual({ status: 'expired' });
    expect(evaluateStopOrder(buyStop(100, 1), 12, candle(99, 105, 98, 99))).toEqual({ status: 'expired' });
  });

  it('resolves a bracket whose legs both trigger to the leg nearer the open, flagged ambiguous', () => {
    const bracket: PendingStopOrder = {
      legs: [
        { side: 'long', triggerPrice: 110 },
        { side: 'short', triggerPrice: 95 },
      ],
      placedBar: 10,
      timeoutBars: 1,
    };
    // Open 98: the sell stop is 3 away, the buy stop 12.
    expect(evaluateStopOrder(bracket, 11, candle(98, 111, 94, 100))).toEqual({
      status: 'filled',
      leg: 1,
      fillPrice: 95,
      ambiguous: true,
    });
    // Only one leg reached: not ambiguous.
    expect(evaluateStopOrder(bracket, 11, candle(108, 111, 100, 109))).toEqual({
      status: 'filled',
      leg: 0,
      fillPrice: 110,
      ambiguous: false,
    });
  });
});
