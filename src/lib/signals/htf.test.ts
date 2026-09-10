// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  getConfirmationInterval,
  computeHtfSeries,
  htfContextAtBar,
  alignHtfToLtf,
} from './htf';
import { intervalToMs } from '@/lib/intervals';
import type { OHLCV } from '@/types/market';

const HOUR = 60 * 60 * 1000;
const BASE = 1700006400000; // UTC midnight

function makeCandles(count: number, intervalMs: number, seed = 33): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = seed;

  function nextRandom(): number {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
    price = price * (1 + 0.002 + (nextRandom() - 0.5) * 0.004);
    candles.push({
      timestamp: BASE + i * intervalMs,
      open: price * 0.999,
      high: price * 1.004,
      low: price * 0.996,
      close: price,
      volume: 1000,
    });
  }

  return candles;
}

describe('getConfirmationInterval', () => {
  it('maps each interval to its confirmation timeframe', () => {
    expect(getConfirmationInterval('1m')).toBe('15m');
    expect(getConfirmationInterval('5m')).toBe('1h');
    expect(getConfirmationInterval('15m')).toBe('4h');
    expect(getConfirmationInterval('1h')).toBe('4h');
    expect(getConfirmationInterval('4h')).toBe('1d');
  });

  it('caps at 1d with no confirmation', () => {
    expect(getConfirmationInterval('1d')).toBeNull();
    expect(getConfirmationInterval('1d', 'position_trading')).toBeNull();
  });

  it('returns null for unknown intervals', () => {
    expect(getConfirmationInterval('1w')).toBeNull();
  });
});

describe('computeHtfSeries / htfContextAtBar', () => {
  it('produces a context with the three trend signals past warmup', () => {
    const candles = makeCandles(250, 4 * HOUR);
    const series = computeHtfSeries(candles);
    const ctx = htfContextAtBar(series, 240, '4h');

    expect(ctx).not.toBeNull();
    expect(ctx!.interval).toBe('4h');
    expect(ctx!.candleTimestamp).toBe(candles[240].timestamp);
    expect(ctx!.signals.map((s) => s.name)).toEqual([
      'HTF EMA Cross',
      'HTF SMA Trend',
      'HTF SuperTrend',
    ]);
    expect(['bullish', 'bearish', 'neutral']).toContain(ctx!.trendDirection);
  });

  it('is bullish on a steady uptrend', () => {
    const candles = makeCandles(250, 4 * HOUR);
    const series = computeHtfSeries(candles);
    const ctx = htfContextAtBar(series, 249, '4h');

    expect(ctx!.trendDirection).toBe('bullish');
  });

  it('returns null during warmup', () => {
    const candles = makeCandles(250, 4 * HOUR);
    const series = computeHtfSeries(candles);

    expect(htfContextAtBar(series, 5, '4h')).toBeNull();
    expect(htfContextAtBar(series, -1, '4h')).toBeNull();
    expect(htfContextAtBar(series, 250, '4h')).toBeNull();
  });

  it('is causal: context at bar N is identical when future bars are removed', () => {
    const candles = makeCandles(250, 4 * HOUR);
    const probeBar = 230;

    const full = htfContextAtBar(computeHtfSeries(candles), probeBar, '4h');
    const truncated = htfContextAtBar(
      computeHtfSeries(candles.slice(0, probeBar + 1)),
      probeBar,
      '4h'
    );

    expect(truncated).toEqual(full);
  });
});

describe('alignHtfToLtf', () => {
  const ltfMs = intervalToMs('1h');
  const htfMs = intervalToMs('4h');

  it('never maps an LTF bar to an HTF bar that closes after it', () => {
    const ltf = makeCandles(48, ltfMs);
    const htf = makeCandles(12, htfMs);

    const map = alignHtfToLtf(ltf, ltfMs, htf, htfMs);

    for (let i = 0; i < ltf.length; i++) {
      if (map[i] === -1) continue;
      expect(htf[map[i]].timestamp + htfMs).toBeLessThanOrEqual(ltf[i].timestamp + ltfMs);
    }
  });

  it('maps the simultaneous close boundary to the just-closed HTF bar', () => {
    const ltf = makeCandles(8, ltfMs);
    const htf = makeCandles(2, htfMs);

    const map = alignHtfToLtf(ltf, ltfMs, htf, htfMs);

    // LTF bars 0-2 close before the first HTF bar completes
    expect(map[0]).toBe(-1);
    expect(map[2]).toBe(-1);
    // LTF bar 3 closes exactly when HTF bar 0 closes (equality allowed)
    expect(map[3]).toBe(0);
    expect(map[6]).toBe(0);
    // LTF bar 7 closes with HTF bar 1
    expect(map[7]).toBe(1);
  });

  it('tolerates gaps in HTF data', () => {
    const ltf = makeCandles(12, ltfMs);
    const htf = makeCandles(3, htfMs).filter((_, i) => i !== 1); // drop the middle bar

    const map = alignHtfToLtf(ltf, ltfMs, htf, htfMs);

    // Bars during the gap keep the last closed HTF bar
    expect(map[5]).toBe(0);
    expect(map[11]).toBe(1); // third original bar, now index 1
  });

  it('returns all -1 with empty HTF input', () => {
    const ltf = makeCandles(5, ltfMs);
    const map = alignHtfToLtf(ltf, ltfMs, [], htfMs);
    expect([...map]).toEqual([-1, -1, -1, -1, -1]);
  });
});
