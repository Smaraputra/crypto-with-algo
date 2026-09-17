// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { parseArgs } from './export-dataset';

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
