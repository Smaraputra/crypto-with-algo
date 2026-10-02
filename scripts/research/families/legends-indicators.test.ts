import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@/types/market';
import type { Strategy } from '@/lib/backtest/strategy';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtest/types';
import {
  adx,
  bollinger,
  cached,
  ema,
  highest,
  lowest,
  nextOpenEntryWrapper,
  rsi,
  trueRange,
  turtleN,
  wilder,
} from './legends-indicators';

const bar = (high: number, low: number, close: number, open = close): OHLCV => ({
  timestamp: 0,
  open,
  high,
  low,
  close,
  volume: 1,
});

describe('legends indicators', () => {
  const five = [bar(10, 8, 9), bar(12, 9, 11), bar(13, 10, 12), bar(12, 9, 10), bar(14, 11, 13)];

  it('true range uses the previous close and is undefined on the first bar', () => {
    expect(Array.from(trueRange(five)).slice(1)).toEqual([3, 3, 3, 4]);
    expect(trueRange(five)[0]).toBeNaN();
  });

  it('wilder seeds with the mean of n values and smooths with (n - 1) / n', () => {
    const w = wilder(Float64Array.from([Number.NaN, 2, 4, 6, 8]), 2, 1);
    expect(w[1]).toBeNaN();
    expect(w[2]).toBe(3);
    expect(w[3]).toBe(4.5);
    expect(w[4]).toBe(6.25);
  });

  it('ADX by hand at n = 2', () => {
    const { adx: a, plusDi, minusDi } = adx(five, 2);
    expect(plusDi[2]).toBeCloseTo(50, 10);
    expect(minusDi[2]).toBeCloseTo(0, 10);
    expect(plusDi[3]).toBeCloseTo(25, 10);
    expect(minusDi[3]).toBeCloseTo(100 / 6, 10);
    expect(plusDi[4]).toBeCloseTo((100 * 2.75) / 7, 10);
    // DX 100, 20, then 100 x 32.142857 / 46.428571; ADX seeded at bar 3 with mean(100, 20).
    expect(a[3]).toBeCloseTo(60, 10);
    const dx4 = (100 * ((100 * 2.75) / 7 - (100 * 0.5) / 7)) / ((100 * 2.75) / 7 + (100 * 0.5) / 7);
    expect(a[4]).toBeCloseTo((60 + dx4) / 2, 10);
  });

  it('RSI is 100 with no losses and follows Wilder averages otherwise', () => {
    const up = [1, 2, 3, 4].map((c) => bar(c, c, c));
    expect(rsi(up, 2)[2]).toBe(100);
    // Changes +2, -1, +3: at n = 2 the seed is gains 1, losses 0.5, then gains 2, losses 0.25.
    const mixed = [10, 12, 11, 14].map((c) => bar(c, c, c));
    const r = rsi(mixed, 2);
    expect(r[2]).toBeCloseTo(100 - 100 / (1 + 1 / 0.5), 10);
    expect(r[3]).toBeCloseTo(100 - 100 / (1 + 2 / 0.25), 10);
  });

  it('EMA seeds with the simple mean then applies alpha 2 / (n + 1)', () => {
    const e = ema([1, 2, 3, 4].map((c) => bar(c, c, c)), 3);
    expect(e[1]).toBeNaN();
    expect(e[2]).toBe(2);
    expect(e[3]).toBe(3);
  });

  it('Turtle N is a 20-bar Wilder average of true range', () => {
    const c = Array.from({ length: 25 }, (_, i) => bar(101 + (i % 2), 99, 100));
    const n = turtleN(c);
    expect(n[19]).toBeNaN();
    expect(n[20]).toBeCloseTo(2.5, 10);
  });

  it('Bollinger uses the population standard deviation', () => {
    const b = bollinger([1, 2, 3].map((c) => bar(c, c, c)), 3, 2);
    const sd = Math.sqrt(2 / 3);
    expect(b.middle[2]).toBe(2);
    expect(b.upper[2]).toBeCloseTo(2 + 2 * sd, 12);
    expect(b.lower[2]).toBeCloseTo(2 - 2 * sd, 12);
  });

  it('highest and lowest are inclusive', () => {
    expect(highest(five, 1, 3)).toBe(13);
    expect(lowest(five, 2, 4)).toBe(9);
  });

  it('caches a series per candle array', () => {
    let calls = 0;
    const compute = () => {
      calls++;
      return new Float64Array(1);
    };
    cached(five, 'x', compute);
    cached(five, 'x', compute);
    cached([...five], 'x', compute);
    expect(calls).toBe(2);
  });

  it('nextOpenEntryWrapper turns a market decision into a next-open one with fill-relative distances', () => {
    const inner: Strategy = {
      name: 'inner',
      decideEntry: () => ({ side: 'long', orderType: 'market', stopPrice: 98, targetPrice: 104, timeStopBars: 5 }),
      decideExit: () => false,
    };
    const ctx = { bar: 0, candles: [bar(100, 100, 100)] } as unknown as Parameters<Strategy['decideEntry']>[0];
    const d = nextOpenEntryWrapper(inner).decideEntry(ctx, DEFAULT_BACKTEST_CONFIG)!;
    expect(d.orderType).toBe('next-open');
    expect(d.fillRelative?.stopFraction).toBeCloseTo(0.02, 12);
    expect(d.fillRelative?.targetFraction).toBeCloseTo(0.04, 12);
    expect(d.timeStopBars).toBe(5);
  });
});
