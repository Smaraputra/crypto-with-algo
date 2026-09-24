import { describe, expect, it } from 'vitest';

import type { OHLCV } from '@/types/market';

import { computeAllIndicators } from './compute';
import { interpretIndicators, interpretVolume, interpretTakerFlow, interpretOBV } from './interpret';

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

describe('interpretVolume', () => {
  const makeVa = (ratio: number, priceChangePercent: number) => ({
    currentVolume: ratio * 100,
    sma20Volume: 100,
    ratio,
    priceChangePercent,
  });

  it('high volume with rising price confirms bullish', () => {
    const result = interpretVolume(makeVa(2.0, 0.5));

    expect(result.direction).toBe('bullish');
    expect(result.strength).toBeCloseTo(60); // 40 + (2.0 - 1.5) * 40
  });

  it('high volume with falling price confirms bearish', () => {
    const result = interpretVolume(makeVa(2.0, -0.5));

    expect(result.direction).toBe('bearish');
    expect(result.strength).toBeCloseTo(60);
  });

  it('strength is capped at 90 for extreme volume', () => {
    const result = interpretVolume(makeVa(5.0, 1.0));

    expect(result.direction).toBe('bullish');
    expect(result.strength).toBe(90);
  });

  it('high volume without a clear price move stays neutral', () => {
    const result = interpretVolume(makeVa(2.0, 0.05));

    expect(result.direction).toBe('neutral');
  });

  it('low volume is low-conviction neutral', () => {
    const result = interpretVolume(makeVa(0.3, 1.0));

    expect(result.direction).toBe('neutral');
    expect(result.strength).toBe(20);
  });

  it('average volume is neutral', () => {
    const result = interpretVolume(makeVa(1.0, 0.5));

    expect(result.direction).toBe('neutral');
    expect(result.strength).toBe(10);
  });
});

describe('interpretTakerFlow', () => {
  const makeVa = (takerBuyRatio?: number) => ({
    currentVolume: 100,
    sma20Volume: 100,
    ratio: 1,
    priceChangePercent: 0,
    ...(takerBuyRatio !== undefined ? { takerBuyRatio } : {}),
  });

  it('is bullish when takers are lifting the offer', () => {
    const result = interpretTakerFlow(makeVa(0.6));
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('bullish');
    expect(result!.strength).toBe(80); // (0.6 - 0.5) * 800
  });

  it('is bearish when takers are hitting the bid', () => {
    const result = interpretTakerFlow(makeVa(0.4));
    expect(result!.direction).toBe('bearish');
    expect(result!.strength).toBe(80);
  });

  it('caps strength at 85', () => {
    expect(interpretTakerFlow(makeVa(0.95))!.strength).toBe(85);
    expect(interpretTakerFlow(makeVa(0.05))!.strength).toBe(85);
  });

  it('returns null in the indifferent band', () => {
    expect(interpretTakerFlow(makeVa(0.5))).toBeNull();
    expect(interpretTakerFlow(makeVa(0.54))).toBeNull();
    expect(interpretTakerFlow(makeVa(0.46))).toBeNull();
  });

  it('returns null when taker data is absent', () => {
    expect(interpretTakerFlow(makeVa())).toBeNull();
  });
});

describe('interpretOBV magnitude is origin-independent', () => {
  /**
   * OBV is a cumulative sum whose zero point is bar 0 of whatever window was
   * fetched, so its LEVEL is arbitrary. The strength used to be normalised by
   * |sma20|, making it a function of that arbitrary level: where OBV happened
   * to be large the strength was ~0.1, and where the running sum happened to
   * straddle zero it pinned at 100.
   */
  function obvFrom(values: number[]) {
    const window = values.slice(-20);
    const sma20 = window.reduce((a, b) => a + b, 0) / window.length;
    return { values, current: values[values.length - 1], sma20 };
  }

  /** A fixed volume pattern, offset so only the cumulative origin differs. */
  function series(offset: number) {
    const deltas = [100, -80, 120, -60, 140, -40, 160, -20, 180, 100,
                    -70, 130, -50, 150, -30, 170, -10, 190, 110, 200];
    const out: number[] = [offset];
    for (const d of deltas) out.push(out[out.length - 1] + d);
    return out;
  }

  it('gives the same strength whatever the cumulative origin', () => {
    const near = interpretOBV(obvFrom(series(0)));
    const far = interpretOBV(obvFrom(series(10_000_000)));

    expect(near.direction).toBe(far.direction);
    expect(near.strength).toBeCloseTo(far.strength, 6);
  });

  it('does not pin at full strength when the running sum straddles zero', () => {
    // The old normalisation divided by |sma20|, so an sma20 near zero blew the
    // ratio up and clamped to 100 regardless of the actual divergence.
    const straddling = series(0).map((v, i) => v - 900 - i);
    const result = interpretOBV(obvFrom(straddling));

    expect(result.strength).toBeLessThan(100);
  });

  it('scales with the size of the divergence in bars of volume', () => {
    const base = series(0);
    // Push the last value further from its average; strength must increase.
    const stretched = [...base];
    stretched[stretched.length - 1] = base[base.length - 1] + 400;

    expect(interpretOBV(obvFrom(stretched)).strength).toBeGreaterThan(
      interpretOBV(obvFrom(base)).strength
    );
  });

  it('still reports direction from the average, not the magnitude', () => {
    const rising = series(0);
    const falling = [...rising].reverse();

    expect(interpretOBV(obvFrom(rising)).direction).toBe('bullish');
    expect(interpretOBV(obvFrom(falling)).direction).toBe('bearish');
  });
});
