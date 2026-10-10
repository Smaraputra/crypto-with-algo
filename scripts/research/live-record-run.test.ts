// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { analyseCell, buildReport, countOnly, formatTable, parseArgs, parseExportText, verifySha256 } from './live-record-run';
import type { LiveRow } from './live-record-stats';

function row(over: Partial<LiveRow> = {}): LiveRow {
  return {
    symbol: 'BTCUSDT',
    interval: '5m',
    tradingStyle: 'scalping',
    tier: 'buy',
    score: 40,
    configVersion: 8,
    candleTimestamp: 0,
    horizonBars: 12,
    forwardReturnPercent: 0.1,
    ...over,
  };
}

describe('parseArgs', () => {
  it('requires --export and --out', () => {
    expect(() => parseArgs([])).toThrow('--export is required');
    expect(() => parseArgs(['--export', 'a'])).toThrow('--out is required');
    expect(parseArgs(['--export', 'a', '--out', 'b', '--expect-sha256', 'AB', '--cutoff-ms', '5'])).toEqual({
      exportPath: 'a',
      outPath: 'b',
      expectSha256: 'ab',
      cutoffMs: 5,
    });
    expect(() => parseArgs(['--x'])).toThrow('Unknown flag');
  });
});

describe('parseExportText', () => {
  it('drops and counts non-finite rows and reads an optional header', () => {
    const text = [
      JSON.stringify({ kind: 'live-record-export', cutoffMs: 99 }),
      JSON.stringify(row()),
      JSON.stringify({ ...row(), forwardReturnPercent: null }),
      '',
    ].join('\n');
    const p = parseExportText(text);
    expect(p.rows).toHaveLength(1);
    expect(p.dropped).toBe(1);
    expect(p.cutoffMs).toBe(99);
  });
});

describe('verifySha256', () => {
  it('returns the hash and rejects a mismatch', () => {
    const buf = Buffer.from('abc');
    const h = verifySha256(buf, null);
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(verifySha256(buf, h)).toBe(h);
    expect(() => verifySha256(buf, 'deadbeef')).toThrow('sha256 mismatch');
  });
});

describe('report', () => {
  const rows: LiveRow[] = [];
  for (let t = 0; t < 400; t++) {
    rows.push(row({ candleTimestamp: t * 300_000, tier: t % 2 ? 'buy' : 'sell', forwardReturnPercent: t % 2 ? 0.1 : -0.1 }));
  }
  rows.push(row({ configVersion: 5 }), row({ configVersion: 8, interval: '1d', tradingStyle: 'swing_trading' }));

  it('analyses a cell with a verdict for version 8 only', () => {
    const v8 = analyseCell(rows.filter((r) => r.interval === '5m'), 8, 'scalping', '5m', 100, 13);
    expect(v8.costPercent).toBeCloseTo(0.2, 12);
    expect(v8.horizonBars).toBe(12);
    expect(v8.timelinePositions).toBe(400);
    expect(v8.spanHorizons).toBeCloseTo(400 / 12, 6);
    expect(v8.measures.bh).toBeGreaterThan(0.99);
    expect(v8.verdict?.verdict).toBe('RIGHT');
    expect(analyseCell(rows.filter((r) => r.interval === '5m'), 7, 'scalping', '5m', 20, 13).verdict).toBeNull();
  });

  it('counts only versions 5 and 6 and 1d, and builds a complete report', () => {
    expect(countOnly(rows)).toEqual({ '5|scalping|5m': 1, '8|swing_trading|1d': 1 });
    const rep = buildReport({ rows, dropped: 2, cutoffMs: null }, 'abc', 123, 'deadbee', 20, 13);
    expect(rep.reportKind).toBe('live-record');
    expect(rep.cells).toHaveLength(15);
    expect(rep.cutoffMs).toBe(123);
    expect(rep.exportSha256).toBe('abc');
    expect(rep.rowsDropped).toBe(2);
    const empty = rep.cells.find((c) => c.version === 8 && c.interval === '4h');
    expect(empty?.verdict?.verdict).toBe('NOT ASSESSABLE');
    expect(formatTable(rep).split('\n')).toHaveLength(16);
  });
});
