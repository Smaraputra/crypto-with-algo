// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { computeWarmupBars, interpretIndicatorsAtBar } from './interpret-at-bar';
import { computeAllIndicators } from './compute';
import type { OHLCV } from '@/types/market';

// Generate synthetic candle data with a trend
function generateCandles(count: number, startPrice = 100, seed = 42): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = startPrice;
  let rng = seed;

  function nextRandom(): number {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
    const change = (nextRandom() - 0.48) * 2; // slight upward bias
    price = price * (1 + change / 100);
    const high = price * (1 + nextRandom() * 0.01);
    const low = price * (1 - nextRandom() * 0.01);
    const open = price * (1 + (nextRandom() - 0.5) * 0.005);
    const volume = 1000 + nextRandom() * 5000;

    candles.push({
      timestamp: 1700000000000 + i * 3600000,
      open,
      high,
      low,
      close: price,
      volume,
    });
  }

  return candles;
}

describe('computeWarmupBars', () => {
  it('returns warmup based on longest indicator period', () => {
    const candles = generateCandles(300);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const warmup = computeWarmupBars(raw);

    // SMA(200) needs 199 warmup bars, so warmup should be at least 199
    expect(warmup).toBeGreaterThanOrEqual(199);
    // But not more than the candle count
    expect(warmup).toBeLessThan(candles.length);
  });
});

describe('interpretIndicatorsAtBar', () => {
  const candles = generateCandles(300);
  const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
  const warmup = computeWarmupBars(raw);

  it('produces an IndicatorSuite at a valid bar', () => {
    const suite = interpretIndicatorsAtBar(raw, warmup + 10, candles);

    expect(suite.symbol).toBe('BTCUSDT');
    expect(suite.interval).toBe('1h');
    expect(suite.signals.trend.length).toBeGreaterThan(0);
    expect(suite.signals.momentum.length).toBeGreaterThan(0);
    expect(suite.signals.volatility.length).toBeGreaterThan(0);
    expect(suite.signals.volume.length).toBeGreaterThan(0);
  });

  it('sets current values to match the bar', () => {
    const barIdx = warmup + 20;
    const suite = interpretIndicatorsAtBar(raw, barIdx, candles);

    // Current values should be actual numbers, not NaN
    expect(Number.isFinite(suite.ema12.current)).toBe(true);
    expect(Number.isFinite(suite.rsi.current)).toBe(true);
    expect(Number.isFinite(suite.atr.current)).toBe(true);
    expect(Number.isFinite(suite.macd.current.MACD)).toBe(true);
  });

  it('produces different results at different bars', () => {
    const suite1 = interpretIndicatorsAtBar(raw, warmup + 5, candles);
    const suite2 = interpretIndicatorsAtBar(raw, warmup + 50, candles);

    // EMA values should differ at different bars
    expect(suite1.ema12.current).not.toBe(suite2.ema12.current);
  });

  it('produces valid signal directions', () => {
    const suite = interpretIndicatorsAtBar(raw, warmup + 10, candles);

    const validDirections = ['bullish', 'bearish', 'neutral'];
    for (const sig of suite.signals.trend) {
      expect(validDirections).toContain(sig.direction);
      expect(sig.strength).toBeGreaterThanOrEqual(0);
      expect(sig.strength).toBeLessThanOrEqual(100);
    }
  });

  it('sets lastCandleTime to the bar timestamp', () => {
    const barIdx = warmup + 10;
    const suite = interpretIndicatorsAtBar(raw, barIdx, candles);

    expect(suite.lastCandleTime).toBe(candles[barIdx].timestamp);
  });
});
