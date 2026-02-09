import { describe, expect, it } from 'vitest';

import type { OHLCV } from '@/types/market';

import { computeAllIndicators } from './compute';
import { interpretIndicators } from './interpret';

// Generate realistic OHLCV data
function generateCandles(count: number, startPrice = 40000, trend: 'up' | 'down' | 'sideways' = 'up'): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = startPrice;
  const baseTime = Date.now() - count * 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    let change: number;
    if (trend === 'up') {
      change = (Math.sin(i * 0.1) * 0.01 + 0.003) * price;
    } else if (trend === 'down') {
      change = (Math.sin(i * 0.1) * 0.01 - 0.003) * price;
    } else {
      change = Math.sin(i * 0.2) * 0.005 * price;
    }

    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * (1 + Math.random() * 0.003);
    const low = Math.min(open, close) * (1 - Math.random() * 0.003);
    const volume = 100 + Math.random() * 200;

    candles.push({
      timestamp: baseTime + i * 60 * 60 * 1000,
      open,
      high,
      low,
      close,
      volume,
    });
    price = close;
  }

  return candles;
}

describe('interpretIndicators', () => {
  it('returns all signal categories', () => {
    const candles = generateCandles(300);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const result = interpretIndicators(raw);

    expect(result.signals.trend.length).toBeGreaterThanOrEqual(2);
    expect(result.signals.momentum.length).toBe(4);
    expect(result.signals.volatility.length).toBe(2);
    expect(result.signals.volume.length).toBe(3);
  });

  it('preserves raw indicator data', () => {
    const candles = generateCandles(300);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const result = interpretIndicators(raw);

    expect(result.symbol).toBe('BTCUSDT');
    expect(result.interval).toBe('1h');
    expect(result.ema12).toBe(raw.ema12);
    expect(result.rsi).toBe(raw.rsi);
  });

  it('each signal has valid structure', () => {
    const candles = generateCandles(300);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const result = interpretIndicators(raw);

    const allSignals = [
      ...result.signals.trend,
      ...result.signals.momentum,
      ...result.signals.volatility,
      ...result.signals.volume,
    ];

    for (const s of allSignals) {
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('value');
      expect(s).toHaveProperty('direction');
      expect(s).toHaveProperty('strength');
      expect(s).toHaveProperty('description');
      expect(['bullish', 'bearish', 'neutral']).toContain(s.direction);
      expect(s.strength).toBeGreaterThanOrEqual(0);
      expect(s.strength).toBeLessThanOrEqual(100);
    }
  });

  it('uptrend candles produce bullish trend signals', () => {
    const candles = generateCandles(300, 40000, 'up');
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const result = interpretIndicators(raw);

    const emaCross = result.signals.trend.find((s) => s.name === 'EMA Cross');
    expect(emaCross).toBeDefined();
    // In a strong uptrend, EMA12 should be above EMA26
    expect(emaCross!.direction).toBe('bullish');
  });

  it('downtrend candles produce bearish trend signals', () => {
    const candles = generateCandles(300, 40000, 'down');
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const result = interpretIndicators(raw);

    const emaCross = result.signals.trend.find((s) => s.name === 'EMA Cross');
    expect(emaCross).toBeDefined();
    expect(emaCross!.direction).toBe('bearish');
  });

  it('RSI interpretation follows overbought/oversold thresholds', () => {
    const candles = generateCandles(300);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const result = interpretIndicators(raw);

    const rsiSignal = result.signals.momentum.find((s) => s.name === 'RSI');
    expect(rsiSignal).toBeDefined();

    const rsi = raw.rsi.current;
    if (rsi > 70) expect(rsiSignal!.direction).toBe('bearish');
    else if (rsi < 30) expect(rsiSignal!.direction).toBe('bullish');
  });

  it('MACD interpretation reflects histogram sign', () => {
    const candles = generateCandles(300);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const result = interpretIndicators(raw);

    const macdSignal = result.signals.momentum.find((s) => s.name === 'MACD');
    expect(macdSignal).toBeDefined();

    const { MACD: macdLine, histogram } = raw.macd.current;
    if (macdLine > 0 && histogram > 0) {
      expect(macdSignal!.direction).toBe('bullish');
    } else if (macdLine < 0 && histogram < 0) {
      expect(macdSignal!.direction).toBe('bearish');
    }
  });

  it('Bollinger Bands %B interpretation', () => {
    const candles = generateCandles(300);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const result = interpretIndicators(raw);

    const bbSignal = result.signals.volatility.find((s) => s.name === 'Bollinger');
    expect(bbSignal).toBeDefined();

    const pb = raw.bollingerBands.current.pb;
    if (pb > 1.0) expect(bbSignal!.direction).toBe('bearish');
    else if (pb < 0.0) expect(bbSignal!.direction).toBe('bullish');
  });

  it('includes Ichimoku signal when data is sufficient', () => {
    const candles = generateCandles(300);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const result = interpretIndicators(raw);

    if (raw.ichimoku) {
      const ichimokuSignal = result.signals.trend.find((s) => s.name === 'Ichimoku');
      expect(ichimokuSignal).toBeDefined();
    }
  });

  it('volume signals include OBV, MFI, and Volume', () => {
    const candles = generateCandles(300);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const result = interpretIndicators(raw);

    const names = result.signals.volume.map((s) => s.name);
    expect(names).toContain('OBV');
    expect(names).toContain('MFI');
    expect(names).toContain('Volume');
  });

  it('strength values are clamped to 0-100', () => {
    const candles = generateCandles(300);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const result = interpretIndicators(raw);

    const allSignals = [
      ...result.signals.trend,
      ...result.signals.momentum,
      ...result.signals.volatility,
      ...result.signals.volume,
    ];

    for (const s of allSignals) {
      expect(s.strength).toBeGreaterThanOrEqual(0);
      expect(s.strength).toBeLessThanOrEqual(100);
    }
  });
});
