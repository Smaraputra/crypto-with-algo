import { describe, expect, it, vi } from 'vitest';
import type { OHLCV } from '@/types/market';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { prepareBacktest } from './optimized-engine';

// Spy on computeAllIndicators to verify config passthrough
vi.mock('@/lib/indicators/compute', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/indicators/compute')>();
  return {
    ...actual,
    computeAllIndicators: vi.fn(actual.computeAllIndicators),
  };
});

import { computeAllIndicators } from '@/lib/indicators/compute';

function generateCandles(count: number): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 40000;
  const baseTime = Date.now() - count * 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    const change = (Math.sin(i * 0.1) * 0.01 + 0.001) * price;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;

    candles.push({
      timestamp: baseTime + i * 60 * 60 * 1000,
      open, high, low, close,
      volume: 100 + Math.random() * 200,
    });
    price = close;
  }
  return candles;
}

describe('prepareBacktest', () => {
  it('uses DEFAULT_CONFIG when no indicatorConfig is provided', () => {
    const candles = generateCandles(250);
    prepareBacktest(candles, 'BTCUSDT', '1h');

    // When omitted, prepareBacktest passes undefined; computeAllIndicators defaults internally
    expect(computeAllIndicators).toHaveBeenCalledWith(
      candles, 'BTCUSDT', '1h', undefined
    );

    // Verify default params are actually used by checking output
    const result = prepareBacktest(candles, 'BTCUSDT', '1h');
    const lastBar = result.indicators[result.indicators.length - 1];
    expect(lastBar.ema12.period).toBe(12);
    expect(lastBar.ema26.period).toBe(26);
    expect(lastBar.rsi.period).toBe(14);
  });

  it('passes custom indicatorConfig to computeAllIndicators', () => {
    const scalpingProfile = getStyleConfig('scalping');
    const candles = generateCandles(100);

    prepareBacktest(candles, 'BTCUSDT', '1m', scalpingProfile.config);

    expect(computeAllIndicators).toHaveBeenCalledWith(
      candles, 'BTCUSDT', '1m', scalpingProfile.config
    );
  });

  it('scalping config produces indicators with shorter periods', () => {
    const scalpingConfig = getStyleConfig('scalping').config;
    const candles = generateCandles(100);

    const result = prepareBacktest(candles, 'BTCUSDT', '5m', scalpingConfig);

    // Scalping uses EMA 5/13 instead of default 12/26
    const lastBar = result.indicators[result.indicators.length - 1];
    expect(lastBar.ema12.period).toBe(5);
    expect(lastBar.ema26.period).toBe(13);
    expect(lastBar.rsi.period).toBe(7);
  });

  it('position config produces indicators with longer periods', () => {
    const positionConfig = getStyleConfig('position_trading').config;
    const candles = generateCandles(500);

    const result = prepareBacktest(candles, 'BTCUSDT', '1d', positionConfig);

    const lastBar = result.indicators[result.indicators.length - 1];
    expect(lastBar.ema12.period).toBe(50);
    expect(lastBar.ema26.period).toBe(200);
    expect(lastBar.rsi.period).toBe(28);
    expect(lastBar.sma50.period).toBe(100);
    expect(lastBar.sma200.period).toBe(400);
  });

  it('returns pre-computed indicators for all bars', () => {
    const candles = generateCandles(250);
    const result = prepareBacktest(candles, 'BTCUSDT', '1h');

    expect(result.candles).toBe(candles);
    expect(result.indicators).toHaveLength(candles.length);
    expect(result.warmupBars).toBeGreaterThan(0);
    expect(result.superTrend.length).toBeGreaterThan(0);
  });

  it('warmupBars is smaller with scalping config (shorter periods)', () => {
    const defaultCandles = generateCandles(250);
    const defaultResult = prepareBacktest(defaultCandles, 'BTCUSDT', '1h');

    const scalpingConfig = getStyleConfig('scalping').config;
    const scalpingCandles = generateCandles(100);
    const scalpingResult = prepareBacktest(scalpingCandles, 'BTCUSDT', '5m', scalpingConfig);

    // Scalping needs fewer warmup bars due to shorter periods
    expect(scalpingResult.warmupBars).toBeLessThan(defaultResult.warmupBars);
  });
});
