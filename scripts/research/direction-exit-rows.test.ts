// scripts/research/direction-exit-rows.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { datasetHashOf, sha256File } from './dataset-format';
import { DIRECTION_EXIT_SYMBOLS } from './direction-exit';
import {
  assertDatasetHash, assertRowsMeta, buildDxRows, CATEGORIES, parseArgs, pathAt, type DxRowsMeta, type PathInput,
} from './direction-exit-rows';

const HOUR = 3_600_000;
function path(closes: number[], gapAt?: number): PathInput {
  const t = closes.map((_, i) => (gapAt !== undefined && i >= gapAt ? i + 1 : i) * HOUR);
  return { t, o: closes.map((c) => c - 0.5), h: closes.map((c) => c + 1), l: closes.map((c) => c - 1), c: closes };
}

describe('pathAt', () => {
  it('measures the extremes after the signal bar, from its close and from the next open', () => {
    const p = path([100, 101, 104, 99, 102]);
    const r = pathAt(p, 0, 3, HOUR)!;
    expect(r.up).toBeCloseTo(5); // high 105 over close 100
    expect(r.down).toBeCloseTo(-2); // low 98 over close 100
    expect(r.fwd1).toBeCloseTo(((99 - 100.5) / 100.5) * 100); // close[3] over open[1]
    expect(r.up1).toBeCloseTo(((105 - 100.5) / 100.5) * 100);
  });

  it('returns null when the horizon runs past the data or spans a gap', () => {
    expect(pathAt(path([1, 2, 3]), 1, 3, HOUR)).toBeNull();
    expect(pathAt(path([100, 101, 102, 103, 104], 2), 0, 3, HOUR)).toBeNull();
  });
});

describe('buildDxRows', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
  const p = path(closes);
  const names = ['composite', ...CATEGORIES.map((c) => `cat.${c}`), 'raw.realizedVol20'];
  const values = names.map((name) => Float64Array.from(closes, (_, i) => (name === 'composite' ? (i % 3 === 0 ? 30 : 5) : name === 'cat.sentiment' ? NaN : i)));
  const atr14 = Float64Array.from(closes, () => 2);
  const window = { start: new Date(0).toISOString(), end: new Date(30 * HOUR).toISOString() };

  it('emits every scored bar with its tier, categories, volatility, hour, ATR and outcome', () => {
    const { rows } = buildDxRows({ symbol: 'BTCUSDT', interval: '1h', style: 'day_trading', horizonBars: 4, path: p, names, values, atr14, window });
    expect(rows[0]).toMatchObject({ t: 0, score: 30, tier: 'buy', hourUtc: 0, vol20: 0 });
    expect(rows[0].cats.sentiment).toBeNull();
    expect(rows[0].cats.trend).toBe(0);
    expect(rows[0].atrPct).toBeCloseTo(2);
    expect(rows[0].fwd).toBeCloseTo(4);
    expect(rows[1].tier).toBe('neutral');
  });

  it('drops bars without an outcome and counts them', () => {
    const { rows, dropped, pastWindowEnd } = buildDxRows({ symbol: 'BTCUSDT', interval: '1h', style: 'day_trading', horizonBars: 4, path: p, names, values, atr14, window: { start: window.start, end: new Date(100 * HOUR).toISOString() } });
    expect(rows.at(-1)!.t).toBe(35 * HOUR);
    expect(dropped).toBe(4);
    expect(pastWindowEnd).toBe(0);
  });

  it('keeps a bar whose horizon closes exactly at the window end and drops the next one, counting it', () => {
    // Window end = the close of bar 29. Bar 25's horizon (4 bars) ends at that close; bar 26's ends an hour later.
    const end = new Date(30 * HOUR - 1).toISOString();
    const { rows, dropped, pastWindowEnd } = buildDxRows({ symbol: 'BTCUSDT', interval: '1h', style: 'day_trading', horizonBars: 4, path: p, names, values, atr14, window: { start: window.start, end } });
    expect(rows.at(-1)!.t).toBe(25 * HOUR);
    expect(pastWindowEnd).toBe(4); // bars 26 to 29
    expect(dropped).toBe(0);
  });

  it('keeps scores-only rows up to the window end, since they carry no horizon', () => {
    const end = new Date(30 * HOUR - 1).toISOString();
    const { rows, pastWindowEnd } = buildDxRows({ symbol: 'BTCUSDT', interval: '1h', style: 'day_trading', horizonBars: 4, path: p, names, values, atr14, window: { start: window.start, end }, scoresOnly: true });
    expect(rows.at(-1)!.t).toBe(29 * HOUR);
    expect(pastWindowEnd).toBe(0);
  });

  it('carries no return in scores-only mode', () => {
    const { rows } = buildDxRows({ symbol: 'BTCUSDT', interval: '1h', style: 'day_trading', horizonBars: 4, path: p, names, values, atr14, window, scoresOnly: true });
    expect(Number.isNaN(rows[0].fwd)).toBe(true);
    expect(Number.isNaN(rows[0].up)).toBe(true);
  });
});

describe('parseArgs', () => {
  const base = ['--dataset-dir', 'd', '--out', 'o', '--start', '2022-01-01', '--end', '2024-12-31T23:59:59.999Z'];
  it('requires the expected manifest hash and defaults to the study symbols', () => {
    expect(() => parseArgs(base)).toThrow(/expectManifestHash/);
    const a = parseArgs([...base, '--expect-manifest-hash', 'abc']);
    expect(a.expectManifestHash).toBe('abc');
    expect(a.symbols).toEqual([...DIRECTION_EXIT_SYMBOLS]);
  });
});

describe('assertDatasetHash', () => {
  it('passes a verified dataset with the expected hash and throws on another hash or a changed file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dx-ds-'));
    writeFileSync(join(dir, 'a.jsonl.gz'), 'rows');
    const sha256 = await sha256File(join(dir, 'a.jsonl.gz'));
    const files = [{ path: 'a.jsonl.gz', kind: 'candles', symbol: 'BTCUSDT', interval: '1h', rowCount: 1, startMs: 0, endMs: 0, sha256 }];
    const datasetHash = datasetHashOf(files);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, generatedAt: '', commit: '', lockboxStart: '', symbols: [], intervals: [], files, datasetHash }));
    await expect(assertDatasetHash(dir, datasetHash)).resolves.toBe(datasetHash);
    await expect(assertDatasetHash(dir, 'other')).rejects.toThrow(/hash mismatch/);
    writeFileSync(join(dir, 'a.jsonl.gz'), 'changed');
    await expect(assertDatasetHash(dir, datasetHash)).rejects.toThrow(/verification failed/);
  });
});

describe('assertRowsMeta', () => {
  const meta: DxRowsMeta = {
    datasetHash: 'h', sha256: 's', rows: 1, dropped: 0, pastWindowEnd: 0, start: '2022-01-01T00:00:00.000Z',
    end: '2024-12-31T23:59:59.999Z', intervals: ['1h', '4h'], symbols: ['BTCUSDT'], scoresOnly: false, gitCommit: 'c',
  };
  const window = { start: '2022-01-01T00:00:00Z', end: '2024-12-31T23:59:59.999Z' };
  it('accepts the matching sidecar and names each mismatch', () => {
    expect(() => assertRowsMeta(meta, { datasetHash: 'h', sha256: 's', scoresOnly: false, window })).not.toThrow();
    expect(() => assertRowsMeta(meta, { datasetHash: 'x', sha256: 's', scoresOnly: false })).toThrow(/datasetHash/);
    expect(() => assertRowsMeta(meta, { datasetHash: 'h', sha256: 'x', scoresOnly: false })).toThrow(/sha256/);
    expect(() => assertRowsMeta(meta, { datasetHash: 'h', sha256: 's', scoresOnly: true })).toThrow(/scoresOnly/);
    expect(() => assertRowsMeta(meta, { datasetHash: 'h', sha256: 's', scoresOnly: false, window: { ...window, end: '2025-01-01' } })).toThrow(/window/);
  });
});
