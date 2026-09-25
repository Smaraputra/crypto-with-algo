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
  // The reading is now a z against the ratio's own trailing window, so these
  // supply one directly. The band, the cap and the abstention are unchanged in
  // intent; only the axis they are measured on moved off the fixed 0.5 centre.
  const makeVa = (takerBuyRatio?: number, takerBuyRatioZ?: number) => ({
    currentVolume: 100,
    sma20Volume: 100,
    ratio: 1,
    priceChangePercent: 0,
    ...(takerBuyRatio !== undefined ? { takerBuyRatio } : {}),
    ...(takerBuyRatioZ !== undefined ? { takerBuyRatioZ } : {}),
  });

  it('is bullish when takers are lifting the offer', () => {
    const result = interpretTakerFlow(makeVa(0.6, 2));
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('bullish');
    expect(result!.strength).toBe(57); // round(2 / 3 * 85)
  });

  it('is bearish when takers are hitting the bid', () => {
    const result = interpretTakerFlow(makeVa(0.4, -2));
    expect(result!.direction).toBe('bearish');
    expect(result!.strength).toBe(57);
  });

  it('caps strength at 85', () => {
    expect(interpretTakerFlow(makeVa(0.95, 9))!.strength).toBe(85);
    expect(interpretTakerFlow(makeVa(0.05, -9))!.strength).toBe(85);
  });

  it('returns null in the indifferent band', () => {
    expect(interpretTakerFlow(makeVa(0.5, 0))).toBeNull();
    expect(interpretTakerFlow(makeVa(0.54, 1.4))).toBeNull();
    expect(interpretTakerFlow(makeVa(0.46, -1.4))).toBeNull();
  });

  it('fires on a large move that the old fixed band called indifferent', () => {
    expect(interpretTakerFlow(makeVa(0.54, 2.5))!.direction).toBe('bullish');
  });

  it('abstains on an extreme ratio that is normal for this series', () => {
    // 0.05 was maximum bearish conviction under the fixed band. If that is
    // simply where this book sits, it carries no information.
    expect(interpretTakerFlow(makeVa(0.05, 0.2))).toBeNull();
  });

  it('returns null when taker data is absent', () => {
    expect(interpretTakerFlow(makeVa())).toBeNull();
  });

  it('returns null when the window has no spread to measure against', () => {
    expect(interpretTakerFlow(makeVa(0.6))).toBeNull();
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

describe('MACD strength is scale-invariant', () => {
  // generateCandles scales every move by `price`, so these two series are the
  // same pattern expressed at price levels four orders of magnitude apart --
  // exactly the BTC-versus-DOGE case. Momentum is identical by construction,
  // so any difference in strength is the scoring, not the market.
  function macdStrengthAt(startPrice: number): number {
    const suite = interpretIndicators(
      computeAllIndicators(generateCandles(250, startPrice, 'up'), 'TESTUSDT', '1h')
    );
    const macd = suite.signals.momentum.find((s) => s.name === 'MACD');
    if (!macd) throw new Error('MACD signal missing from the momentum suite');
    return macd.strength;
  }

  it('scores an identical pattern the same at 40000 and at 0.1', () => {
    expect(macdStrengthAt(0.1)).toBeCloseTo(macdStrengthAt(40000), 6);
  });

  it('does not pin a high-priced asset at the cap while zeroing a low-priced one', () => {
    const high = macdStrengthAt(40000);
    const low = macdStrengthAt(0.1);
    expect(high).toBeLessThan(100);
    expect(low).toBeGreaterThan(1);
  });
});

describe('EMA Cross strength is volatility-invariant', () => {
  // The EMA spread is already a percentage, so it is scale-free across
  // symbols. What it is NOT is scale-free across intervals: a 1d EMA(50)/
  // EMA(200) spread is far wider in percentage terms than a 5m EMA(5)/EMA(13)
  // one, and a fixed multiplier therefore reads ~0 at 5m and saturates at 1d.
  // Scaling every percentage move by the same factor is the cleanest
  // expression of that difference: strength should not move.
  function trendingCandles(count: number, volMultiple: number): OHLCV[] {
    const candles: OHLCV[] = [];
    let price = 100;
    const baseTime = Date.UTC(2024, 0, 1);
    for (let i = 0; i < count; i++) {
      const move = (Math.sin(i * 0.1) * 0.01 + 0.003) * volMultiple;
      const open = price;
      const close = price * (1 + move);
      candles.push({
        timestamp: baseTime + i * 3_600_000,
        open,
        high: Math.max(open, close) * (1 + 0.001 * volMultiple),
        low: Math.min(open, close) * (1 - 0.001 * volMultiple),
        close,
        volume: 1000,
        takerBuyVolume: 500,
      });
      price = close;
    }
    return candles;
  }

  function emaStrengthAtVolatility(volMultiple: number): number {
    const suite = interpretIndicators(
      computeAllIndicators(trendingCandles(250, volMultiple), 'TESTUSDT', '1h')
    );
    const ema = suite.signals.trend.find((s) => s.name === 'EMA Cross');
    if (!ema) throw new Error('EMA Cross signal missing from the trend suite');
    return ema.strength;
  }

  it('scores the same pattern within a tenth at 1x and 3x volatility', () => {
    // Not exact equality: the series compounds, so tripling every per-bar move
    // is not a pure rescaling of the path, and an EMA is not linear in it. The
    // fixed multiplier gave 100 against 32.9 here, a ratio above 3; scaling by
    // the spread's own magnitude leaves a ratio near 1.1, which is the
    // generator's non-linearity rather than the scoring.
    const ratio = emaStrengthAtVolatility(3) / emaStrengthAtVolatility(1);
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
  });

  it('does not saturate on volatility alone', () => {
    // A violent series is not a more confident trend than a calm one with the
    // same shape. Under the fixed multiplier this pinned at 100.
    expect(emaStrengthAtVolatility(10)).toBeLessThan(100);
  });
});

describe('Taker flow is measured against its own recent behaviour', () => {
  // A fixed 0.55/0.45 band is both miscentred and interval-blind. Measured
  // across ten symbols the ratio's true centre is 0.492 to 0.495, never 0.5,
  // and the band fires on 77.9% of 5m bars against 6.3% of 1d bars.
  function candlesWithTakerRatios(ratios: number[]): OHLCV[] {
    const baseTime = Date.UTC(2024, 0, 1);
    return ratios.map((ratio, i) => {
      const price = 100 + Math.sin(i * 0.3);
      return {
        timestamp: baseTime + i * 3_600_000,
        open: price,
        high: price * 1.002,
        low: price * 0.998,
        close: price,
        volume: 1000,
        takerBuyVolume: 1000 * ratio,
      };
    });
  }

  function takerSignal(ratios: number[]) {
    const suite = interpretIndicators(
      computeAllIndicators(candlesWithTakerRatios(ratios), 'TESTUSDT', '1h')
    );
    return suite.signals.volume.find((s) => s.name === 'Taker Flow');
  }

  it('abstains when the ratio sits at its own steady level, however far from 0.5', () => {
    // A book that always runs 44% taker-buy is not persistently bearish, it is
    // just that book. The fixed band called this bearish on every single bar.
    expect(takerSignal(new Array(260).fill(0.44))).toBeUndefined();
  });

  it('fires when the ratio breaks from its own steady level inside the old band', () => {
    // 0.46 sits inside the old 0.45-0.55 indifference band, so this was
    // invisible, despite being a large move for this series.
    const ratios = new Array(260).fill(0.5);
    ratios[ratios.length - 1] = 0.46;
    const sig = takerSignal(ratios);
    expect(sig?.direction).toBe('bearish');
  });
});
