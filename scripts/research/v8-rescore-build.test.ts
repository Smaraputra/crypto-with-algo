// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { serializeRows } from '../ops/export-live-outcomes';
import { buildCellRows, forwardReturnAt, parseArgs } from './v8-rescore-build';

const MIN = 60_000;
const H = 5 * MIN;
const T0 = Date.parse('2025-10-01T00:00:00.000Z');

function series(n: number, gapAt: number[] = []) {
  const timestamps: number[] = [];
  const closes: number[] = [];
  let t = T0;
  for (let i = 0; i < n; i++) {
    if (gapAt.includes(i)) t += H;
    timestamps.push(t);
    closes.push(100 + i);
    t += H;
  }
  return { timestamps, closes };
}

describe('forwardReturnAt', () => {
  it('is the close-to-close percent horizonBars later', () => {
    const { timestamps, closes } = series(20);
    expect(forwardReturnAt(timestamps, closes, 0, 4, H)).toBeCloseTo(4, 10);
    expect(forwardReturnAt(timestamps, closes, 5, 10, H)).toBeCloseTo((10 / 105) * 100, 10);
  });

  it('is null when the horizon runs past the data end', () => {
    const { timestamps, closes } = series(10);
    expect(forwardReturnAt(timestamps, closes, 6, 4, H)).toBeNull();
    expect(forwardReturnAt(timestamps, closes, 5, 4, H)).not.toBeNull();
  });

  it('is null when a forward bar is missing, even if the horizon bar exists', () => {
    const { timestamps, closes } = series(20, [8]);
    expect(forwardReturnAt(timestamps, closes, 3, 6, H)).toBeNull();
    expect(forwardReturnAt(timestamps, closes, 10, 6, H)).not.toBeNull();
  });
});

describe('buildCellRows', () => {
  const base = { symbol: 'BTCUSDT', interval: '5m', style: 'scalping', horizonBars: 3 };

  it('emits tiers at the v8 cutoffs 28 and 36 (strictly above)', () => {
    const { timestamps, closes } = series(12);
    const composite = [28, 28.01, 36, 36.01, -28, -28.01, -36, -36.01, 0, 0, 0, 0];
    const { rows } = buildCellRows({ ...base, timestamps, closes, composite });
    expect(rows.map((r) => r.tier)).toEqual([
      'neutral',
      'buy',
      'buy',
      'strong_buy',
      'neutral',
      'sell',
      'sell',
      'strong_sell',
      'neutral',
    ]);
    expect(rows[0]).toMatchObject({ configVersion: 8, horizonBars: 3, tradingStyle: 'scalping', interval: '5m' });
  });

  it('drops rows without an outcome and counts them; skips non-finite scores silently', () => {
    const { timestamps, closes } = series(10);
    const composite = [1, NaN, 1, 1, 1, 1, 1, 1, 1, 1];
    const { rows, dropped } = buildCellRows({ ...base, timestamps, closes, composite });
    expect(dropped).toBe(3);
    expect(rows).toHaveLength(6);
    expect(rows.some((r) => r.candleTimestamp === timestamps[1])).toBe(false);
  });

  it('keeps only bars inside the window, inclusive at both ends', () => {
    const { timestamps, closes } = series(20);
    const composite = new Array<number>(20).fill(30);
    const window = {
      start: new Date(timestamps[5]).toISOString(),
      end: new Date(timestamps[9]).toISOString(),
    };
    const { rows } = buildCellRows({ ...base, timestamps, closes, composite, window });
    expect(rows.map((r) => r.candleTimestamp)).toEqual(timestamps.slice(5, 10));
  });
});

describe('serialization and args', () => {
  it('sorts like the live export and hashes the bytes', () => {
    const { timestamps, closes } = series(8);
    const a = buildCellRows({
      symbol: 'ETHUSDT',
      interval: '5m',
      style: 'scalping',
      horizonBars: 3,
      timestamps,
      closes,
      composite: new Array<number>(8).fill(30),
    }).rows;
    const b = buildCellRows({
      symbol: 'BTCUSDT',
      interval: '5m',
      style: 'scalping',
      horizonBars: 3,
      timestamps,
      closes,
      composite: new Array<number>(8).fill(30),
    }).rows;
    const out = serializeRows([...a, ...b]);
    const lines = gunzipSync(out.gz).toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(10);
    expect(JSON.parse(lines[0]).symbol).toBe('BTCUSDT');
    expect(JSON.parse(lines[1]).symbol).toBe('ETHUSDT');
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses flags and rejects missing ones', () => {
    expect(parseArgs(['--dataset-dir', 'd', '--out', 'o', '--symbols', 'BTCUSDT,ETHUSDT'])).toEqual({
      datasetDir: 'd',
      out: 'o',
      symbols: ['BTCUSDT', 'ETHUSDT'],
    });
    expect(() => parseArgs(['--out', 'o'])).toThrow('--dataset-dir');
    expect(() => parseArgs(['--dataset-dir', 'd'])).toThrow('--out');
  });
});
