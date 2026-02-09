import { describe, expect, it } from 'vitest';

import type { OHLCV } from '@/types/market';

import { computeSuperTrend } from './supertrend';

function generateCandles(
  count: number,
  startPrice = 100,
  trend: 'up' | 'down' | 'sideways' = 'sideways'
): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = startPrice;
  const baseTime = Date.now() - count * 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    let change: number;
    if (trend === 'up') {
      change = 0.5 + Math.sin(i * 0.2) * 0.3;
    } else if (trend === 'down') {
      change = -0.5 + Math.sin(i * 0.2) * 0.3;
    } else {
      change = Math.sin(i * 0.3) * 1;
    }

    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * 0.5;
    const low = Math.min(open, close) - Math.random() * 0.5;

    candles.push({
      timestamp: baseTime + i * 60 * 60 * 1000,
      open,
      high,
      low,
      close,
      volume: 1000,
    });
    price = close;
  }

  return candles;
}

describe('computeSuperTrend', () => {
  it('returns correct structure', () => {
    const candles = generateCandles(50);
    const result = computeSuperTrend(candles);

    expect(result).toHaveProperty('values');
    expect(result).toHaveProperty('current');
    expect(result.current).toHaveProperty('supertrend');
    expect(result.current).toHaveProperty('direction');
    expect(result.current).toHaveProperty('upperBand');
    expect(result.current).toHaveProperty('lowerBand');
  });

  it('direction is up or down', () => {
    const candles = generateCandles(50);
    const result = computeSuperTrend(candles);

    for (const point of result.values) {
      expect(['up', 'down']).toContain(point.direction);
    }
  });

  it('upperBand > lowerBand always', () => {
    const candles = generateCandles(50);
    const result = computeSuperTrend(candles);

    for (const point of result.values) {
      expect(point.upperBand).toBeGreaterThan(point.lowerBand);
    }
  });

  it('supertrend equals lowerBand when bullish', () => {
    const candles = generateCandles(50);
    const result = computeSuperTrend(candles);

    for (const point of result.values) {
      if (point.direction === 'up') {
        expect(point.supertrend).toBe(point.lowerBand);
      }
    }
  });

  it('supertrend equals upperBand when bearish', () => {
    const candles = generateCandles(50);
    const result = computeSuperTrend(candles);

    for (const point of result.values) {
      if (point.direction === 'down') {
        expect(point.supertrend).toBe(point.upperBand);
      }
    }
  });

  it('uptrend produces bullish direction', () => {
    const candles = generateCandles(100, 100, 'up');
    const result = computeSuperTrend(candles);

    // After enough uptrend, last few points should be bullish
    const lastFew = result.values.slice(-5);
    const bullishCount = lastFew.filter((p) => p.direction === 'up').length;
    expect(bullishCount).toBeGreaterThanOrEqual(3);
  });

  it('downtrend produces bearish direction', () => {
    const candles = generateCandles(100, 200, 'down');
    const result = computeSuperTrend(candles);

    const lastFew = result.values.slice(-5);
    const bearishCount = lastFew.filter((p) => p.direction === 'down').length;
    expect(bearishCount).toBeGreaterThanOrEqual(3);
  });

  it('throws on insufficient candles', () => {
    const candles = generateCandles(5);
    expect(() => computeSuperTrend(candles)).toThrow('SuperTrend needs at least');
  });

  it('respects custom period and multiplier', () => {
    const candles = generateCandles(50);
    const result5 = computeSuperTrend(candles, 5, 2);
    const result20 = computeSuperTrend(candles, 20, 4);

    // Different parameters should produce different values
    expect(result5.current.supertrend).not.toBe(result20.current.supertrend);
    // Shorter period = more values
    expect(result5.values.length).toBeGreaterThan(result20.values.length);
  });

  it('current is the last value in the array', () => {
    const candles = generateCandles(50);
    const result = computeSuperTrend(candles);
    expect(result.current).toEqual(result.values[result.values.length - 1]);
  });

  it('produces values aligned with ATR output length', () => {
    const candles = generateCandles(50);
    const period = 10;
    const result = computeSuperTrend(candles, period);
    // ATR produces (candles.length - period) values
    expect(result.values.length).toBe(candles.length - period);
  });
});
