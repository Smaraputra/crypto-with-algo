import { describe, expect, it } from 'vitest';

import type { OHLCV } from '@/types/market';
import type { TradingStyle } from '@/lib/models/signal-template';

import { computeIndicatorsForStyle } from './compute-for-style';
import { computeAllIndicators, computeMinCandles } from './compute';
import { interpretIndicators } from './interpret';
import { STYLE_CONFIGS } from './style-configs';
import { DEFAULT_CONFIG } from './types';

function generateCandles(count: number, startPrice = 40000): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = startPrice;
  const baseTime = Date.now() - count * 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    const change = (Math.sin(i * 0.1) * 0.02 + 0.001) * price;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * (1 + Math.random() * 0.005);
    const low = Math.min(open, close) * (1 - Math.random() * 0.005);
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

describe('computeMinCandles', () => {
  it('returns 210 for DEFAULT_CONFIG (SMA 200 is the longest warmup)', () => {
    const min = computeMinCandles(DEFAULT_CONFIG);
    // SMA long=200, ichimoku span+displacement=52+26=78
    // Max is 200, plus 10 buffer = 210
    expect(min).toBe(210);
  });

  it('returns lower value for scalping config (with ichimoku skipped)', () => {
    const min = computeMinCandles(
      STYLE_CONFIGS.scalping.config,
      STYLE_CONFIGS.scalping.skipIndicators
    );
    // SMA long=50 is the longest warmup when ichimoku is skipped, plus 10 buffer = 60
    expect(min).toBe(60);
    expect(min).toBeLessThan(computeMinCandles(DEFAULT_CONFIG));
  });

  it('returns higher value for position_trading config', () => {
    const min = computeMinCandles(STYLE_CONFIGS.position_trading.config);
    // SMA long=400, ichimoku span+displacement=104+26=130
    // Max is 400, plus 10 buffer = 410
    expect(min).toBe(410);
    expect(min).toBeGreaterThan(computeMinCandles(DEFAULT_CONFIG));
  });

  it('each style minCandles is at least computeMinCandles (accounting for skips)', () => {
    const styles: TradingStyle[] = ['scalping', 'day_trading', 'swing_trading', 'position_trading'];
    for (const style of styles) {
      const profile = STYLE_CONFIGS[style];
      const computed = computeMinCandles(profile.config, profile.skipIndicators);
      expect(profile.minCandles).toBeGreaterThanOrEqual(computed - 10);
    }
  });
});

describe('computeAllIndicators with custom config', () => {
  it('throws with insufficient candles for scalping config', () => {
    const candles = generateCandles(30);
    expect(() => computeAllIndicators(candles, 'BTCUSDT', '5m', STYLE_CONFIGS.scalping.config))
      .toThrow('Insufficient candle data');
  });

  it('accepts fewer candles with scalping config than DEFAULT_CONFIG', () => {
    const candles = generateCandles(100);

    // Scalping config needs ~88, so 100 should work
    const result = computeAllIndicators(candles, 'BTCUSDT', '5m', STYLE_CONFIGS.scalping.config);
    expect(result).toBeDefined();
    expect(result.ema12.period).toBe(5); // scalping fast EMA
    expect(result.ema26.period).toBe(13); // scalping slow EMA

    // DEFAULT_CONFIG needs 210, so 100 should fail
    expect(() => computeAllIndicators(candles, 'BTCUSDT', '1h'))
      .toThrow('Insufficient candle data');
  });

  it('uses correct periods from config', () => {
    const candles = generateCandles(500);
    const result = computeAllIndicators(candles, 'BTCUSDT', '4h', STYLE_CONFIGS.swing_trading.config);

    expect(result.ema12.period).toBe(21); // swing EMA fast
    expect(result.ema26.period).toBe(55); // swing EMA slow
    expect(result.rsi.period).toBe(21); // swing RSI
    expect(result.atr.period).toBe(14);
    expect(result.mfi.period).toBe(14);
  });
});

describe('computeIndicatorsForStyle', () => {
  it('computes indicators for scalping style', () => {
    const candles = generateCandles(100);
    const result = computeIndicatorsForStyle(candles, 'BTCUSDT', '5m', 'scalping');

    expect(result.ema12.period).toBe(5);
    expect(result.ema26.period).toBe(13);
    expect(result.rsi.period).toBe(7);
    expect(result.ichimoku).toBeNull(); // skipped for scalping
    expect(result.signals).toBeDefined();
    expect(result.signals.trend.length).toBeGreaterThan(0);
    expect(result.signals.momentum.length).toBeGreaterThan(0);
  });

  it('computes indicators for day_trading style', () => {
    const candles = generateCandles(500);
    const result = computeIndicatorsForStyle(candles, 'BTCUSDT', '1h', 'day_trading');

    expect(result.ema12.period).toBe(12);
    expect(result.ema26.period).toBe(26);
    expect(result.rsi.period).toBe(14);
    expect(result.ichimoku).not.toBeNull(); // not skipped
  });

  it('computes indicators for swing_trading style', () => {
    const candles = generateCandles(500);
    const result = computeIndicatorsForStyle(candles, 'ETHUSDT', '4h', 'swing_trading');

    expect(result.ema12.period).toBe(21);
    expect(result.ema26.period).toBe(55);
    expect(result.rsi.period).toBe(21);
    expect(result.ichimoku).not.toBeNull();
  });

  it('computes indicators for position_trading style', () => {
    const candles = generateCandles(500);
    const result = computeIndicatorsForStyle(candles, 'BTCUSDT', '1d', 'position_trading');

    expect(result.ema12.period).toBe(50);
    expect(result.ema26.period).toBe(200);
    expect(result.rsi.period).toBe(28);
    expect(result.sma50.period).toBe(100);
  });

  it('produces different indicator values for different styles on same data', () => {
    const candles = generateCandles(500);

    const dayResult = computeIndicatorsForStyle(candles, 'BTCUSDT', '1h', 'day_trading');
    const swingResult = computeIndicatorsForStyle(candles, 'BTCUSDT', '4h', 'swing_trading');

    // Different EMA periods should produce different current values
    expect(dayResult.ema12.current).not.toBe(swingResult.ema12.current);
    expect(dayResult.rsi.current).not.toBe(swingResult.rsi.current);
  });

  it('returns valid IndicatorSuite with all required signal categories', () => {
    const candles = generateCandles(500);
    const styles: TradingStyle[] = ['scalping', 'day_trading', 'swing_trading', 'position_trading'];

    for (const style of styles) {
      const minNeeded = Math.max(STYLE_CONFIGS[style].recommendedCandles, 500);
      const styleCandles = candles.slice(0, minNeeded);
      // Only run if we have enough candles
      if (styleCandles.length >= STYLE_CONFIGS[style].minCandles) {
        const result = computeIndicatorsForStyle(
          styleCandles,
          'BTCUSDT',
          STYLE_CONFIGS[style].preferredIntervals[0],
          style
        );

        expect(result.signals.trend.length).toBeGreaterThan(0);
        expect(result.signals.momentum.length).toBeGreaterThan(0);
        expect(result.signals.volatility.length).toBeGreaterThan(0);
        expect(result.signals.volume.length).toBeGreaterThan(0);
        expect(result.symbol).toBe('BTCUSDT');

        // Verify signal shape on first trend signal
        const sample = result.signals.trend[0];
        expect(sample).toHaveProperty('name');
        expect(sample).toHaveProperty('direction');
        expect(['bullish', 'bearish', 'neutral']).toContain(sample.direction);
      }
    }
  });

  it('produces same result as manual compute+interpret for day_trading', () => {
    const candles = generateCandles(500);
    const config = STYLE_CONFIGS.day_trading.config;

    const manual = interpretIndicators(
      computeAllIndicators(candles, 'BTCUSDT', '1h', config)
    );
    const auto = computeIndicatorsForStyle(candles, 'BTCUSDT', '1h', 'day_trading');

    expect(auto.ema12.current).toBe(manual.ema12.current);
    expect(auto.rsi.current).toBe(manual.rsi.current);
    expect(auto.macd.current).toEqual(manual.macd.current);
  });
});
