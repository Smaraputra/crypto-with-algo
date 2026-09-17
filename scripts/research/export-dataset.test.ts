// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { alignHtfToLtf, computeHtfSeries, htfContextAtBar } from '@/lib/signals/htf';
import { intervalToMs } from '@/lib/intervals';
import type { OHLCV } from '@/types/market';
import { buildHtfRows, parseArgs } from './export-dataset';

// Deterministic LCG matching the pattern in this repo's other tests.
function makeRng(seed: number): () => number {
  let state = seed;
  return function next(): number {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

function generateCandles(count: number, seed: number, startTs: number, intervalMs: number): OHLCV[] {
  const next = makeRng(seed);
  const candles: OHLCV[] = [];
  let price = 100;

  for (let i = 0; i < count; i++) {
    const drift = (next() - 0.5) * 0.01;
    price = price * (1 + drift);
    const high = price * (1 + next() * 0.005);
    const low = price * (1 - next() * 0.005);
    const open = price * (1 + (next() - 0.5) * 0.003);
    candles.push({
      timestamp: startTs + i * intervalMs,
      open,
      high,
      low,
      close: price,
      volume: 1000 + next() * 500,
    });
  }
  return candles;
}

describe('parseArgs', () => {
  it('defaults symbols, intervals, out, and mongo-uri from env', () => {
    const args = parseArgs([], { MONGODB_URI: 'mongodb://env-default/db' });

    expect(args.symbols).toEqual([...SIGNAL_SYMBOLS]);
    expect(args.intervals).toEqual(['5m', '15m', '1h', '4h', '1d']);
    expect(args.out).toBe('data/research');
    expect(args.mongoUri).toBe('mongodb://env-default/db');
    expect(args.start).toBeUndefined();
    expect(args.end).toBeUndefined();
  });

  it('parses comma-separated symbols and intervals', () => {
    const args = parseArgs(
      ['--symbols', 'BTCUSDT,ETHUSDT', '--intervals', '1h,4h'],
      {}
    );

    expect(args.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(args.intervals).toEqual(['1h', '4h']);
  });

  it('parses ISO --start and --end into epoch milliseconds', () => {
    const args = parseArgs(
      ['--start', '2026-01-01T00:00:00.000Z', '--end', '2026-02-01T00:00:00.000Z'],
      {}
    );

    expect(args.start).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(args.end).toBe(Date.parse('2026-02-01T00:00:00.000Z'));
  });

  it('prefers an explicit --mongo-uri over the environment', () => {
    const args = parseArgs(
      ['--mongo-uri', 'mongodb://explicit/db'],
      { MONGODB_URI: 'mongodb://env-default/db' }
    );

    expect(args.mongoUri).toBe('mongodb://explicit/db');
  });

  it('parses a custom --out directory', () => {
    const args = parseArgs(['--out', '/tmp/custom-out'], {});

    expect(args.out).toBe('/tmp/custom-out');
  });

  it('throws on an unparseable --start date', () => {
    expect(() => parseArgs(['--start', 'not-a-date'], {})).toThrow();
  });
});

describe('buildHtfRows config wiring (item 1: must match live scoring, not DEFAULT_CONFIG)', () => {
  const SYMBOL = 'BTCUSDT';
  const DAY = 24 * 3600000;
  const FOUR_HOUR = 4 * 3600000;
  const ONE_HOUR = 3600000;
  const FIVE_MIN = 5 * 60000;

  it('the exported context for a 4h symbol equals computeHtfSeries with the swing config, not day_trading', () => {
    // swing_trading.sma.long is 200; comfortably clear it.
    const htfCandles = generateCandles(230, 8001, 0, DAY);
    const ltfCandles = generateCandles(5, 9001, htfCandles[htfCandles.length - 1].timestamp - 2 * FOUR_HOUR, FOUR_HOUR);
    const swingConfig = getStyleConfig('swing_trading').config;
    const dayTradingConfig = getStyleConfig('day_trading').config;

    const rows = buildHtfRows(SYMBOL, '4h', ltfCandles, '1d', htfCandles, swingConfig);
    const lastRow = rows[rows.length - 1];

    const map = alignHtfToLtf(ltfCandles, intervalToMs('4h'), htfCandles, intervalToMs('1d'));
    const expectedSeries = computeHtfSeries(htfCandles, swingConfig);
    const expectedContext = htfContextAtBar(expectedSeries, map[map.length - 1], '1d');

    expect(expectedContext).not.toBeNull(); // sanity: the fixture actually clears warmup
    expect(lastRow.context).toEqual(expectedContext);

    // Confirm the distinction is real: day_trading's config (== DEFAULT_CONFIG,
    // the bug this test guards) produces a different context on the same data.
    const wrongSeries = computeHtfSeries(htfCandles, dayTradingConfig);
    const wrongContext = htfContextAtBar(wrongSeries, map[map.length - 1], '1d');
    expect(lastRow.context).not.toEqual(wrongContext);
  });

  it('a 5m export uses the scalping config, not day_trading', () => {
    // scalping.sma.long is 50; comfortably clear it.
    const htfCandles = generateCandles(70, 8002, 0, ONE_HOUR);
    const ltfCandles = generateCandles(5, 9002, htfCandles[htfCandles.length - 1].timestamp - 2 * FIVE_MIN, FIVE_MIN);
    const scalpingConfig = getStyleConfig('scalping').config;
    const dayTradingConfig = getStyleConfig('day_trading').config;

    const rows = buildHtfRows(SYMBOL, '5m', ltfCandles, '1h', htfCandles, scalpingConfig);
    const lastRow = rows[rows.length - 1];

    const map = alignHtfToLtf(ltfCandles, intervalToMs('5m'), htfCandles, intervalToMs('1h'));
    const expectedSeries = computeHtfSeries(htfCandles, scalpingConfig);
    const expectedContext = htfContextAtBar(expectedSeries, map[map.length - 1], '1h');

    expect(expectedContext).not.toBeNull();
    expect(lastRow.context).toEqual(expectedContext);

    const wrongSeries = computeHtfSeries(htfCandles, dayTradingConfig);
    const wrongContext = htfContextAtBar(wrongSeries, map[map.length - 1], '1h');
    expect(lastRow.context).not.toEqual(wrongContext);
  });
});
