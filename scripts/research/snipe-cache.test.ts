// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSymbolArrays } from './snipe-matrix';
import { cachePaths, readSnipeCache, writeSnipeCache } from './snipe-cache';
import { parseArgs, runSnipeBuild } from './snipe-build';
import { writeSnipeFixture } from './snipe-fixture';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

let dir: string;
let out: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'snipe-cache-ds-'));
  out = mkdtempSync(join(tmpdir(), 'snipe-cache-out-'));
  await writeSnipeFixture(dir, ['BTCUSDT'], [99]);
}, 60_000);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

describe('snipe cache', { timeout: 30_000 }, () => {
  it('round-trips every array and the metadata', () => {
    const a = buildSymbolArrays(dir, 'BTCUSDT', 'intraday');
    const index = writeSnipeCache(out, a, { datasetManifestHash: 'abc', gitCommit: 'deadbeef' });
    expect(index.gitCommit).toBe('deadbeef');
    const { index: idx2, data } = readSnipeCache(out, 'BTCUSDT', 'intraday');
    expect(idx2.datasetManifestHash).toBe('abc');
    expect(data.symbol).toBe('BTCUSDT');
    expect(data.columns).toEqual(a.columns);
    expect(data.warmupBars).toBe(a.warmupBars);
    expect(data.finiteShare).toEqual(a.finiteShare);
    const same = (x: ArrayLike<number>, y: ArrayLike<number>) =>
      Array.from(x).every((v, i) => Object.is(v, y[i])) && x.length === y.length;
    expect(data.timestamps.constructor).toBe(Float64Array);
    for (const k of ['timestamps', 'outcome', 'entryMs', 'exitMs', 'atrPct', 'atrQuintile', 'month'] as const) {
      expect(same(data[k], a[k])).toBe(true);
    }
    a.flags.forEach((f, i) => expect(same(data.flags[i], f)).toBe(true));
  });

  it('detects a modified .bin', () => {
    const a = buildSymbolArrays(dir, 'BTCUSDT', 'intraday');
    writeSnipeCache(out, a, { datasetManifestHash: 'abc' });
    const { bin } = cachePaths(out, 'BTCUSDT', 'intraday');
    const bytes = readFileSync(bin);
    bytes[10] ^= 0xff;
    writeFileSync(bin, bytes);
    expect(() => readSnipeCache(out, 'BTCUSDT', 'intraday')).toThrow(/sha256/);
    writeSnipeCache(out, a, { datasetManifestHash: 'abc' });
    appendFileSync(bin, Buffer.from([1]));
    expect(() => readSnipeCache(out, 'BTCUSDT', 'intraday')).toThrow(/sha256/);
  });
});

describe('snipe-build', () => {
  it('parses flags with defaults', () => {
    const args = parseArgs(['--dataset-dir', 'd', '--out', 'o']);
    expect(args.symbols).toEqual([...SIGNAL_SYMBOLS]);
    expect(args.timeframes).toEqual(['scalp', 'intraday']);
    expect(() => parseArgs(['--out', 'o'])).toThrow(/dataset-dir/);
    expect(() => parseArgs(['--dataset-dir', 'd', '--out', 'o', '--timeframes', 'x'])).toThrow(/timeframe/);
  });

  it('builds the cache, logs one line per pair and records the manifest hash', async () => {
    const lines: string[] = [];
    const o2 = mkdtempSync(join(tmpdir(), 'snipe-build-out-'));
    await runSnipeBuild({ datasetDir: dir, out: o2, symbols: ['BTCUSDT'], timeframes: ['intraday'] }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]);
    expect(row).toMatchObject({ symbol: 'BTCUSDT', timeframe: 'intraday' });
    expect(Object.keys(row.outcomeCounts)).toEqual(['none', 'up', 'down', 'timeout', 'ambiguous']);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(readSnipeCache(o2, 'BTCUSDT', 'intraday').index.datasetManifestHash).toBe(manifest.datasetHash);
    rmSync(o2, { recursive: true, force: true });
  }, 60_000);

  it('refuses a dataset whose manifest does not verify', async () => {
    const bad = mkdtempSync(join(tmpdir(), 'snipe-bad-'));
    await writeSnipeFixture(bad, ['BTCUSDT'], [5]);
    appendFileSync(join(bad, 'perp', 'BTCUSDT', '4h.jsonl.gz'), 'x');
    await expect(runSnipeBuild({ datasetDir: bad, out, symbols: ['BTCUSDT'], timeframes: ['intraday'] }, () => {})).rejects.toThrow(
      /verification/
    );
    rmSync(bad, { recursive: true, force: true });
  }, 60_000);
});
