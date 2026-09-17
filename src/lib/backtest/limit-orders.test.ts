// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { evaluateLimitOrder, type PendingOrder } from './limit-orders';
import type { OHLCV } from '@/types/market';

const BASE = 1700000000000;
const HOUR = 60 * 60 * 1000;

function makeCandle(overrides: Partial<OHLCV> = {}, bar = 0): OHLCV {
  return {
    timestamp: BASE + bar * HOUR,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
    ...overrides,
  };
}

function longOrder(overrides: Partial<PendingOrder> = {}): PendingOrder {
  return { side: 'long', limitPrice: 100, placedBar: 0, timeoutBars: 5, ...overrides };
}

function shortOrder(overrides: Partial<PendingOrder> = {}): PendingOrder {
  return { side: 'short', limitPrice: 100, placedBar: 0, timeoutBars: 5, ...overrides };
}

describe('evaluateLimitOrder', () => {
  describe('placement bar', () => {
    it('never fills on the placement bar even when the range crosses the limit', () => {
      const order = longOrder({ placedBar: 3 });
      const candle = makeCandle({ low: 95, high: 105 });
      expect(evaluateLimitOrder(order, 3, candle)).toEqual({ status: 'pending' });
    });

    it('is pending on any bar before the placement bar', () => {
      const order = longOrder({ placedBar: 3 });
      const candle = makeCandle({ low: 95, high: 105 });
      expect(evaluateLimitOrder(order, 1, candle)).toEqual({ status: 'pending' });
    });
  });

  describe('long order (buy limit)', () => {
    it('fills on strict breach the next bar', () => {
      const order = longOrder({ placedBar: 0, limitPrice: 100 });
      const candle = makeCandle({ open: 100, low: 99.5, high: 100.5 }, 1);
      expect(evaluateLimitOrder(order, 1, candle)).toEqual({
        status: 'filled',
        fillPrice: 100,
        fillBar: 1,
      });
    });

    it('does not fill on an exact touch', () => {
      const order = longOrder({ placedBar: 0, limitPrice: 100 });
      const candle = makeCandle({ open: 100.5, low: 100, high: 101 }, 1);
      expect(evaluateLimitOrder(order, 1, candle)).toEqual({ status: 'pending' });
    });

    it('gap-through fills at the open when open is already below the limit', () => {
      const order = longOrder({ placedBar: 0, limitPrice: 100 });
      const candle = makeCandle({ open: 95, low: 94, high: 96 }, 1);
      expect(evaluateLimitOrder(order, 1, candle)).toEqual({
        status: 'filled',
        fillPrice: 95,
        fillBar: 1,
      });
    });
  });

  describe('short order (sell limit) mirrors a long order', () => {
    it('fills on strict breach the next bar', () => {
      const order = shortOrder({ placedBar: 0, limitPrice: 100 });
      const candle = makeCandle({ open: 100, low: 99.5, high: 100.5 }, 1);
      expect(evaluateLimitOrder(order, 1, candle)).toEqual({
        status: 'filled',
        fillPrice: 100,
        fillBar: 1,
      });
    });

    it('does not fill on an exact touch', () => {
      const order = shortOrder({ placedBar: 0, limitPrice: 100 });
      const candle = makeCandle({ open: 99.5, low: 99, high: 100 }, 1);
      expect(evaluateLimitOrder(order, 1, candle)).toEqual({ status: 'pending' });
    });

    it('gap-through fills at the open when open is already above the limit', () => {
      const order = shortOrder({ placedBar: 0, limitPrice: 100 });
      const candle = makeCandle({ open: 105, low: 104, high: 106 }, 1);
      expect(evaluateLimitOrder(order, 1, candle)).toEqual({
        status: 'filled',
        fillPrice: 105,
        fillBar: 1,
      });
    });

    it('never fills on the placement bar even when the range crosses the limit', () => {
      const order = shortOrder({ placedBar: 3 });
      const candle = makeCandle({ low: 95, high: 105 });
      expect(evaluateLimitOrder(order, 3, candle)).toEqual({ status: 'pending' });
    });
  });

  describe('timeout', () => {
    it('stays pending at placedBar + timeoutBars when unfilled', () => {
      const order = longOrder({ placedBar: 10, timeoutBars: 5, limitPrice: 100 });
      const candle = makeCandle({ open: 105, low: 104, high: 106 }, 15);
      expect(evaluateLimitOrder(order, 15, candle)).toEqual({ status: 'pending' });
    });

    it('cancels at placedBar + timeoutBars + 1, even on a bar that would otherwise breach the limit', () => {
      // low is well below limitPrice: this bar would fill if timeout did not
      // take priority, so this proves cancellation wins over a would-be fill.
      const order = longOrder({ placedBar: 10, timeoutBars: 5, limitPrice: 100 });
      const candle = makeCandle({ open: 105, low: 95, high: 106 }, 16);
      expect(evaluateLimitOrder(order, 16, candle)).toEqual({ status: 'cancelled' });
    });

    it('timeoutBars of 1 means only the bar after placement is eligible', () => {
      const order = longOrder({ placedBar: 10, timeoutBars: 1, limitPrice: 100 });
      const eligible = makeCandle({ open: 100.5, low: 99, high: 101 }, 11);
      expect(evaluateLimitOrder(order, 11, eligible)).toEqual({
        status: 'filled',
        fillPrice: 100,
        fillBar: 11,
      });

      const tooLate = makeCandle({ open: 100.5, low: 99, high: 101 }, 12);
      expect(evaluateLimitOrder(order, 12, tooLate)).toEqual({ status: 'cancelled' });
    });

    it('still fills exactly at the timeout bar when the breach happens there', () => {
      const order = longOrder({ placedBar: 10, timeoutBars: 5, limitPrice: 100 });
      const candle = makeCandle({ open: 100.2, low: 99, high: 100.5 }, 15);
      expect(evaluateLimitOrder(order, 15, candle)).toEqual({
        status: 'filled',
        fillPrice: 100,
        fillBar: 15,
      });
    });
  });
});
