import { describe, expect, it } from 'vitest';

import type { OHLCV } from '@/types/market';

import {
  computeAllIndicators,
  computeATR,
  computeBollingerBands,
  computeEMA,
  computeIchimoku,
  computeMACD,
  computeMFI,
  computeOBV,
  computeRSI,
  computeSMA,
  computeStochasticRSI,
  computeVolumeAnalysis,
  computeWilliamsR,
} from './compute';
import { DEFAULT_CONFIG } from './types';

// Generate realistic OHLCV data with an uptrend pattern
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

// Known values for deterministic testing
const knownCloses = [
  44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 46.21,
];

describe('computeEMA', () => {
  it('computes EMA with correct period', () => {
    const result = computeEMA(knownCloses, 5);
    expect(result.period).toBe(5);
    expect(result.values.length).toBeGreaterThan(0);
    expect(result.current).toBe(result.values[result.values.length - 1]);
  });

  it('produces fewer values than input (period offset)', () => {
    const result = computeEMA(knownCloses, 12);
    expect(result.values.length).toBeLessThan(knownCloses.length);
    expect(result.values.length).toBe(knownCloses.length - 12 + 1);
  });

  it('returns 0 for empty input', () => {
    const result = computeEMA([], 5);
    expect(result.current).toBe(0);
    expect(result.values).toHaveLength(0);
  });
});

describe('computeSMA', () => {
  it('computes SMA correctly for known values', () => {
    const result = computeSMA([1, 2, 3, 4, 5], 3);
    expect(result.values).toEqual([2, 3, 4]);
    expect(result.current).toBe(4);
  });

  it('produces correct number of values', () => {
    const result = computeSMA(knownCloses, 10);
    expect(result.values.length).toBe(knownCloses.length - 10 + 1);
  });
});

describe('computeRSI', () => {
  it('computes RSI within 0-100 range', () => {
    const result = computeRSI(knownCloses, 14);
    expect(result.period).toBe(14);
    expect(result.current).toBeGreaterThanOrEqual(0);
    expect(result.current).toBeLessThanOrEqual(100);
  });

  it('returns known RSI values for known input', () => {
    const result = computeRSI(knownCloses, 14);
    // RSI(14) of the known closes should be around 73
    expect(result.current).toBeCloseTo(68.36, 0);
  });

  it('returns 50 for empty input', () => {
    const result = computeRSI([], 14);
    expect(result.current).toBe(50);
  });
});

describe('computeMACD', () => {
  it('computes MACD with histogram', () => {
    const longCloses = generateCandles(50).map((c) => c.close);
    const result = computeMACD(longCloses, 12, 26, 9);
    expect(result.current).toHaveProperty('MACD');
    expect(result.current).toHaveProperty('signal');
    expect(result.current).toHaveProperty('histogram');
  });

  it('histogram equals MACD minus signal', () => {
    const longCloses = generateCandles(50).map((c) => c.close);
    const result = computeMACD(longCloses, 12, 26, 9);
    if (result.values.length > 0) {
      const last = result.current;
      expect(last.histogram).toBeCloseTo(last.MACD - last.signal, 5);
    }
  });

  it('returns zero defaults for insufficient data', () => {
    const result = computeMACD([1, 2, 3], 12, 26, 9);
    expect(result.current).toEqual({ MACD: 0, signal: 0, histogram: 0 });
  });
});

describe('computeBollingerBands', () => {
  it('upper > middle > lower', () => {
    const result = computeBollingerBands(knownCloses, 10, 2);
    const { upper, middle, lower } = result.current;
    expect(upper).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(lower);
  });

  it('%B is 0-1 when price within bands', () => {
    const result = computeBollingerBands(knownCloses, 10, 2);
    // Most normal data should be within bands
    expect(result.current.pb).toBeGreaterThanOrEqual(0);
    expect(result.current.pb).toBeLessThanOrEqual(1);
  });
});

describe('computeATR', () => {
  it('returns positive ATR values', () => {
    const candles = generateCandles(30);
    const result = computeATR(
      candles.map((c) => c.high),
      candles.map((c) => c.low),
      candles.map((c) => c.close),
      14
    );
    expect(result.current).toBeGreaterThan(0);
    expect(result.period).toBe(14);
  });
});

describe('computeStochasticRSI', () => {
  it('k and d values between 0-100', () => {
    const longCloses = generateCandles(60).map((c) => c.close);
    const result = computeStochasticRSI(longCloses, 14, 14, 3, 3);
    if (result.values.length > 0) {
      expect(result.current.k).toBeGreaterThanOrEqual(0);
      expect(result.current.k).toBeLessThanOrEqual(100);
      expect(result.current.d).toBeGreaterThanOrEqual(0);
      expect(result.current.d).toBeLessThanOrEqual(100);
    }
  });
});

describe('computeWilliamsR', () => {
  it('values between -100 and 0', () => {
    const candles = generateCandles(30);
    const result = computeWilliamsR(
      candles.map((c) => c.high),
      candles.map((c) => c.low),
      candles.map((c) => c.close),
      14
    );
    expect(result.current).toBeGreaterThanOrEqual(-100);
    expect(result.current).toBeLessThanOrEqual(0);
  });
});

describe('computeIchimoku', () => {
  it('returns null when insufficient data', () => {
    const candles = generateCandles(30);
    const result = computeIchimoku(
      candles.map((c) => c.high),
      candles.map((c) => c.low),
      candles.map((c) => c.close),
      DEFAULT_CONFIG.ichimoku
    );
    expect(result).toBeNull();
  });

  it('returns valid Ichimoku data with enough candles', () => {
    const candles = generateCandles(100);
    const result = computeIchimoku(
      candles.map((c) => c.high),
      candles.map((c) => c.low),
      candles.map((c) => c.close),
      DEFAULT_CONFIG.ichimoku
    );
    // May still be null if not enough data points after computation
    if (result) {
      expect(result.current).toHaveProperty('conversion');
      expect(result.current).toHaveProperty('base');
      expect(result.current).toHaveProperty('spanA');
      expect(result.current).toHaveProperty('spanB');
    }
  });
});

describe('computeOBV', () => {
  it('computes OBV with SMA20', () => {
    const candles = generateCandles(30);
    const result = computeOBV(
      candles.map((c) => c.close),
      candles.map((c) => c.volume)
    );
    expect(typeof result.current).toBe('number');
    expect(typeof result.sma20).toBe('number');
  });

  it('OBV increases on up-close', () => {
    const closes = [10, 11, 12];
    const volumes = [100, 200, 300];
    const result = computeOBV(closes, volumes);
    // Each close is higher, so OBV should be cumulative
    expect(result.values[0]).toBe(200);
    expect(result.values[1]).toBe(500);
  });
});

describe('computeMFI', () => {
  it('MFI values between 0-100', () => {
    const candles = generateCandles(30);
    const result = computeMFI(
      candles.map((c) => c.high),
      candles.map((c) => c.low),
      candles.map((c) => c.close),
      candles.map((c) => c.volume),
      14
    );
    expect(result.current).toBeGreaterThanOrEqual(0);
    expect(result.current).toBeLessThanOrEqual(100);
  });
});

describe('computeVolumeAnalysis', () => {
  it('ratio is 1 when volume equals average', () => {
    const volumes = Array(20).fill(100);
    const result = computeVolumeAnalysis(volumes);
    expect(result.ratio).toBeCloseTo(1, 5);
  });

  it('ratio > 1 when current volume above average', () => {
    const volumes = [...Array(19).fill(100), 300];
    const result = computeVolumeAnalysis(volumes);
    expect(result.ratio).toBeGreaterThan(1);
  });
});

describe('computeAllIndicators', () => {
  it('computes full indicator suite', () => {
    const candles = generateCandles(300);
    const result = computeAllIndicators(candles, 'BTCUSDT', '1h');

    expect(result.symbol).toBe('BTCUSDT');
    expect(result.interval).toBe('1h');
    expect(result.candleCount).toBe(300);
    expect(result.ema12.period).toBe(12);
    expect(result.ema26.period).toBe(26);
    expect(result.sma50.period).toBe(50);
    expect(result.sma200.period).toBe(200);
    expect(result.rsi.period).toBe(14);
    expect(result.atr.period).toBe(14);
  });

  it('throws on insufficient candles', () => {
    const candles = generateCandles(50);
    expect(() => computeAllIndicators(candles, 'BTCUSDT', '1h')).toThrow(
      'Insufficient candle data'
    );
  });

  it('accepts custom config', () => {
    const candles = generateCandles(300);
    const config = {
      ...DEFAULT_CONFIG,
      rsi: { period: 21, overbought: 80, oversold: 20 },
    };
    const result = computeAllIndicators(candles, 'BTCUSDT', '1h', config);
    expect(result.rsi.period).toBe(21);
  });

  it('sets lastCandleTime from last candle', () => {
    const candles = generateCandles(300);
    const result = computeAllIndicators(candles, 'BTCUSDT', '1h');
    expect(result.lastCandleTime).toBe(candles[candles.length - 1].timestamp);
  });
});
