// @vitest-environment node
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

import {
  compareRows,
  countByVersion,
  exportMatch,
  foldStatusCounts,
  parseArgs,
  serializeRows,
  type ExportRow,
} from './export-live-outcomes';

function r(over: Partial<ExportRow> = {}): ExportRow {
  return {
    symbol: 'BTCUSDT',
    interval: '5m',
    tradingStyle: 'scalping',
    tier: 'buy',
    score: 41.2,
    configVersion: 8,
    candleTimestamp: 1_000,
    horizonBars: 12,
    forwardReturnPercent: 0.12,
    ...over,
  };
}

describe('parseArgs', () => {
  it('defaults and parses both flags', () => {
    expect(parseArgs([])).toEqual({ out: 'live-outcomes-export.jsonl.gz', mongoUri: null });
    expect(parseArgs(['--out', 'x.gz', '--mongo-uri', 'mongodb://h/db'])).toEqual({
      out: 'x.gz',
      mongoUri: 'mongodb://h/db',
    });
  });
  it('rejects unknown flags and missing values', () => {
    expect(() => parseArgs(['--nope'])).toThrow('Unknown flag');
    expect(() => parseArgs(['--out'])).toThrow('requires a value');
    expect(() => parseArgs(['--out', '--mongo-uri'])).toThrow('requires a value');
  });
});

describe('exportMatch', () => {
  it('keeps composite and legacy no-source rows, resolved only', () => {
    expect(exportMatch()).toEqual({ source: { $ne: 'llm' }, status: 'resolved' });
  });
});

describe('serializeRows', () => {
  const rows = [
    r({ configVersion: 8, tradingStyle: 'scalping', interval: '5m', candleTimestamp: 2, symbol: 'B' }),
    r({ configVersion: 7, tradingStyle: 'swing_trading', interval: '4h', candleTimestamp: 9, symbol: 'A' }),
    r({ configVersion: 8, tradingStyle: 'scalping', interval: '1m', candleTimestamp: 5, symbol: 'A' }),
    r({ configVersion: 8, tradingStyle: 'scalping', interval: '5m', candleTimestamp: 2, symbol: 'A' }),
    r({ configVersion: 8, tradingStyle: 'day_trading', interval: '1h', candleTimestamp: 1, symbol: 'A' }),
  ];

  it('sorts by version, style, interval, candleTimestamp, symbol', () => {
    const out = serializeRows(rows);
    expect(out.rows.map((x) => `${x.configVersion}${x.tradingStyle}${x.interval}${x.candleTimestamp}${x.symbol}`)).toEqual([
      '7swing_trading4h9A',
      '8day_trading1h1A',
      '8scalping1m5A',
      '8scalping5m2A',
      '8scalping5m2B',
    ]);
    expect(compareRows(out.rows[0], out.rows[1])).toBeLessThan(0);
  });

  it('writes gzipped JSONL that round-trips and hashes the file bytes', () => {
    const out = serializeRows(rows);
    const lines = gunzipSync(out.gz).toString('utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[0])).toEqual(out.rows[0]);
    expect(out.sha256).toBe(createHash('sha256').update(out.gz).digest('hex'));
  });

  it('is deterministic regardless of input order and does not mutate the input', () => {
    const copy = [...rows];
    const a = serializeRows(rows);
    const b = serializeRows([...rows].reverse());
    expect(a.sha256).toBe(b.sha256);
    expect(rows).toEqual(copy);
  });

  it('handles an empty set', () => {
    expect(gunzipSync(serializeRows([]).gz).toString()).toBe('');
  });
});

describe('counts', () => {
  it('counts rows by version', () => {
    expect(countByVersion([{ configVersion: 8 }, { configVersion: 8 }, { configVersion: 4 }])).toEqual({ '4': 1, '8': 2 });
  });
  it('folds status counts per version x style x interval', () => {
    const out = foldStatusCounts([
      { _id: { configVersion: 8, tradingStyle: 'scalping', interval: '1m', status: 'resolved' }, count: 10 },
      { _id: { configVersion: 8, tradingStyle: 'scalping', interval: '1m', status: 'pending' }, count: 3 },
      { _id: { configVersion: 4, tradingStyle: 'swing_trading', interval: '1d', status: 'pending' }, count: 7 },
    ]);
    expect(out).toEqual({
      '4|swing_trading|1d': { pending: 7 },
      '8|scalping|1m': { resolved: 10, pending: 3 },
    });
    expect(Object.keys(out)[0]).toBe('4|swing_trading|1d');
  });
});
