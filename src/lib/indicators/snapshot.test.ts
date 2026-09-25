// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { buildIndicatorSnapshot } from './snapshot';
import { computeAllIndicators } from './compute';
import { computeSuperTrend } from './supertrend';
import type { OHLCV } from '@/types/market';

/** Same generator the other indicator tests use, so shapes match production. */
function generateCandles(count: number, startPrice = 100, seed = 42): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = startPrice;
  let rng = seed;

  function nextRandom(): number {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
    const change = (nextRandom() - 0.48) * 2;
    price = price * (1 + change / 100);
    const high = price * (1 + nextRandom() * 0.01);
    const low = price * (1 - nextRandom() * 0.01);
    const open = price * (1 + (nextRandom() - 0.5) * 0.005);
    const volume = 1000 + nextRandom() * 5000;

    candles.push({ timestamp: 1700000000000 + i * 3600000, open, high, low, close: price, volume });
  }

  return candles;
}

const candles = generateCandles(300);
const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
const superTrend = computeSuperTrend(candles);

describe('buildIndicatorSnapshot', () => {
  it('carries every numeric field the journal displays, not the eight of twenty the prose parser managed', () => {
    const snapshot = buildIndicatorSnapshot(raw, superTrend.current.direction, null);

    // The fields JournalEntryDetail labels. Every one of these was null under
    // the old client-side reconstruction, which read them out of sentences.
    for (const key of [
      'rsi',
      'macdLine',
      'macdSignal',
      'macdHistogram',
      'bollingerUpper',
      'bollingerMiddle',
      'bollingerLower',
      'ema12',
      'ema26',
      'sma50',
      'sma200',
      'atr',
      'stochRsiK',
      'stochRsiD',
      'williamsR',
      'obv',
      'mfi',
    ] as const) {
      expect(snapshot[key], key).toBeTypeOf('number');
    }
  });

  it('takes each value from the indicator itself rather than from its description', () => {
    const snapshot = buildIndicatorSnapshot(raw, superTrend.current.direction, null);

    expect(snapshot.rsi).toBe(raw.rsi.current);
    expect(snapshot.macdLine).toBe(raw.macd.current.MACD);
    expect(snapshot.macdSignal).toBe(raw.macd.current.signal);
    expect(snapshot.macdHistogram).toBe(raw.macd.current.histogram);
    expect(snapshot.bollingerUpper).toBe(raw.bollingerBands.current.upper);
    expect(snapshot.bollingerLower).toBe(raw.bollingerBands.current.lower);
    expect(snapshot.ema12).toBe(raw.ema12.current);
    expect(snapshot.sma200).toBe(raw.sma200.current);
    expect(snapshot.stochRsiD).toBe(raw.stochasticRSI.current.d);
    expect(snapshot.williamsR).toBe(raw.williamsR.current);
    expect(snapshot.mfi).toBe(raw.mfi.current);
  });

  it('reports ATR in price units, which is what the "ATR" label claims', () => {
    // The old path parsed "High volatility (ATR: 1.25% of price)" and stored
    // 1.25 under a field the detail view labels ATR, so a BTC entry showed an
    // average true range of about one dollar.
    const snapshot = buildIndicatorSnapshot(raw, superTrend.current.direction, null);

    expect(snapshot.atr).toBe(raw.atr.current);
    expect(snapshot.atr).toBeGreaterThan(0);
  });

  it('reports OBV itself, not the period of the average it is compared against', () => {
    // "OBV above 20-period average by 4.2 bars of volume" -- the first number
    // in that sentence is 20, so every entry recorded an OBV of exactly 20.
    const snapshot = buildIndicatorSnapshot(raw, superTrend.current.direction, null);

    expect(snapshot.obv).toBe(raw.obv.current);
  });

  it('keeps the fear and greed label short, and null when sentiment is unavailable', () => {
    const withSentiment = buildIndicatorSnapshot(raw, 'up', {
      fearGreedIndex: 72,
      label: 'Greed',
    });
    expect(withSentiment.fearGreedIndex).toBe(72);
    expect(withSentiment.fearGreedLabel).toBe('Greed');

    const without = buildIndicatorSnapshot(raw, 'up', null);
    expect(without.fearGreedIndex).toBeNull();
    expect(without.fearGreedLabel).toBeNull();
  });

  it('passes the SuperTrend direction through unchanged, including its absence', () => {
    expect(buildIndicatorSnapshot(raw, 'down', null).superTrendDirection).toBe('down');
    expect(buildIndicatorSnapshot(raw, null, null).superTrendDirection).toBeNull();
  });
});
