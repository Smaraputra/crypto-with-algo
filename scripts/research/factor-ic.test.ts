// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LOCKBOX_START_ISO,
  datasetHashOf,
  sha256File,
  writeJsonlGz,
  type CandleRow,
  type DatasetManifest,
  type HtfRow,
  type ManifestFile,
  type SnapshotRow,
} from './dataset-format';
import { validateFactorIcReport } from './report-schema';
import { buildFactorIcReport, parseArgs, runCell, runFactorIc, type FactorIcArgs } from './factor-ic';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const INTERVAL = '1h';
const HOUR = 3_600_000;
const START = Date.UTC(2025, 0, 1);
const COUNT = 600;

// Deterministic LCG matching the pattern used in this repo's other tests
// (e.g. src/lib/backtest/engine-parity.test.ts, scripts/research/factors.test.ts).
function makeRng(seed: number): () => number {
  let state = seed;
  return function next(): number {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

/**
 * AR(1) returns with coefficient 0.8: ret[t] = 0.8*ret[t-1] + noise. Since
 * raw.ret1 at bar t is exactly ret[t] (see factors.ts's simpleReturn) and the
 * horizon-1 forward return at bar t is ret[t+1], raw.ret1 should predict the
 * next bar's return strongly.
 */
function generateAr1Candles(seed: number): CandleRow[] {
  const next = makeRng(seed);
  const rows: CandleRow[] = [];
  let price = 100;
  let prevRet = 0;

  for (let i = 0; i < COUNT; i++) {
    const noise = (next() - 0.5) * 0.02;
    const ret = 0.8 * prevRet + noise;
    prevRet = ret;

    const open = price;
    const close = price * (1 + ret);
    const high = Math.max(open, close) * 1.001;
    const low = Math.min(open, close) * 0.999;
    const volume = 1000 + next() * 500;

    rows.push({ t: START + i * HOUR, o: open, h: high, l: low, c: close, v: volume, tbv: volume * 0.5 });
    price = close;
  }

  return rows;
}

/** Two symbols, 600 1h bars each, empty snapshots, and null-context htf rows. */
async function buildFixtureDataset(dir: string): Promise<DatasetManifest> {
  const files: ManifestFile[] = [];

  for (const [i, symbol] of SYMBOLS.entries()) {
    const candleRows = generateAr1Candles(4242 + i * 1000);
    const snapshotRows: SnapshotRow[] = [];
    const htfRows: HtfRow[] = candleRows.map((c) => ({ t: c.t, context: null }));

    const candlePath = join(dir, 'candles', symbol, `${INTERVAL}.jsonl.gz`);
    const snapshotPath = join(dir, 'snapshots', symbol, `${INTERVAL}.jsonl.gz`);
    const htfPath = join(dir, 'htf', symbol, `${INTERVAL}.jsonl.gz`);

    await writeJsonlGz(candlePath, candleRows);
    await writeJsonlGz(snapshotPath, snapshotRows);
    await writeJsonlGz(htfPath, htfRows);

    files.push(
      {
        path: `candles/${symbol}/${INTERVAL}.jsonl.gz`,
        kind: 'candles',
        symbol,
        interval: INTERVAL,
        rowCount: candleRows.length,
        startMs: candleRows[0].t,
        endMs: candleRows[candleRows.length - 1].t,
        sha256: await sha256File(candlePath),
      },
      {
        path: `snapshots/${symbol}/${INTERVAL}.jsonl.gz`,
        kind: 'snapshots',
        symbol,
        interval: INTERVAL,
        rowCount: 0,
        startMs: null,
        endMs: null,
        sha256: await sha256File(snapshotPath),
      },
      {
        path: `htf/${symbol}/${INTERVAL}.jsonl.gz`,
        kind: 'htf',
        symbol,
        interval: INTERVAL,
        rowCount: htfRows.length,
        startMs: htfRows[0].t,
        endMs: htfRows[htfRows.length - 1].t,
        sha256: await sha256File(htfPath),
      }
    );
  }

  const manifest: DatasetManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    commit: 'test-fixture',
    lockboxStart: LOCKBOX_START_ISO,
    symbols: SYMBOLS,
    intervals: [INTERVAL],
    files,
    datasetHash: datasetHashOf(files),
  };

  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

describe('factor-ic CLI', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'factor-ic-'));
    await buildFixtureDataset(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces a schema-valid report where raw.ret1 predicts the next bar at h=1 (pooled ic > 0.3)', async () => {
    const startedAt = Date.now();
    const args = parseArgs([
      '--interval', INTERVAL,
      '--dataset-dir', dir,
      '--factors', 'raw.ret1,raw.rsi',
      '--bootstrap-n', '100',
      '--allow-lockbox',
      '--out', join(dir, 'reports', 'report.json'),
    ]);

    const report = await buildFactorIcReport(args);
    // Measured fixture runtime (600 bars x 2 symbols, 2 factors, bootstrap-n=100): logged for the C3 report.
    console.error(`[test] buildFactorIcReport fixture runtime: ${Date.now() - startedAt}ms`);

    const validated = validateFactorIcReport(report);
    expect(validated.ok).toBe(true);
    expect(report.lockboxApplied).toBe(false);
    expect(report.symbols).toEqual(SYMBOLS);

    const ret1 = report.factors.find((f) => f.name === 'raw.ret1');
    expect(ret1).toBeDefined();
    const h1 = ret1!.pooled.horizons.find((h) => h.horizon === 1);
    expect(h1).toBeDefined();
    expect(h1!.ic).toBeGreaterThan(0.3);
  }, 30_000);

  it('gates pooled bootstrapCi95 by |icT|: null below the threshold, finite above it', async () => {
    const args = parseArgs([
      '--interval', INTERVAL,
      '--dataset-dir', dir,
      '--factors', 'raw.ret1',
      '--bootstrap-n', '100',
      '--allow-lockbox',
    ]);
    const report = await buildFactorIcReport(args);

    expect(report.bootstrap).toEqual({ iterations: 100, seed: 42, perSymbol: false, gateAbsT: 2, maxPairs: 100_000 });

    const ret1 = report.factors.find((f) => f.name === 'raw.ret1')!;
    const h1 = ret1.pooled.horizons.find((h) => h.horizon === 1)!;
    const h32 = ret1.pooled.horizons.find((h) => h.horizon === 32)!;

    // h1's AR(1)-driven signal is strong (|icT| well above the gate).
    expect(Math.abs(h1.icT)).toBeGreaterThanOrEqual(2);
    expect(h1.bootstrapCi95).not.toBeNull();
    expect(Number.isFinite(h1.bootstrapCi95![0])).toBe(true);
    expect(Number.isFinite(h1.bootstrapCi95![1])).toBe(true);

    // h32's AR(1) persistence has mostly decayed away (|icT| below the gate).
    expect(Math.abs(h32.icT)).toBeLessThan(2);
    expect(h32.bootstrapCi95).toBeNull();
  }, 30_000);

  it('the bootstrap subsample path runs cleanly under a small --bootstrap-max-pairs override', async () => {
    const args = parseArgs([
      '--interval', INTERVAL,
      '--dataset-dir', dir,
      '--factors', 'raw.ret1',
      '--horizons', '1',
      '--bootstrap-n', '50',
      '--bootstrap-max-pairs', '50',
      '--allow-lockbox',
    ]);
    const report = await buildFactorIcReport(args);

    expect(report.bootstrap.maxPairs).toBe(50);

    const h1 = report.factors.find((f) => f.name === 'raw.ret1')!.pooled.horizons.find((h) => h.horizon === 1)!;
    // The fixture pools to several hundred rows, well above maxPairs=50, so
    // this cell only produces a finite interval if the subsample path ran.
    expect(h1.bootstrapCi95).not.toBeNull();
    expect(Number.isFinite(h1.bootstrapCi95![0])).toBe(true);
    expect(Number.isFinite(h1.bootstrapCi95![1])).toBe(true);
    expect(h1.bootstrapCi95![0]).toBeLessThanOrEqual(h1.bootstrapCi95![1]);
  }, 30_000);

  it('the bootstrap subsample is deterministic: two runs, same seed, identical bootstrapCi95', async () => {
    const args = parseArgs([
      '--interval', INTERVAL,
      '--dataset-dir', dir,
      '--factors', 'raw.ret1',
      '--horizons', '1',
      '--bootstrap-n', '50',
      '--bootstrap-max-pairs', '50',
      '--allow-lockbox',
    ]);

    const reportA = await buildFactorIcReport(args);
    const reportB = await buildFactorIcReport(args);

    const ciA = reportA.factors[0].pooled.horizons[0].bootstrapCi95;
    const ciB = reportB.factors[0].pooled.horizons[0].bootstrapCi95;

    expect(ciA).not.toBeNull();
    expect(ciA).toEqual(ciB);
  }, 30_000);

  it('records an all-NaN factor in skippedFactors instead of silently vanishing', async () => {
    const args = parseArgs([
      '--interval', INTERVAL,
      '--dataset-dir', dir,
      '--factors', 'raw.ret1,raw.fundingRate',
      '--bootstrap-n', '10',
      '--allow-lockbox',
    ]);
    const report = await buildFactorIcReport(args);

    expect(report.factors.map((f) => f.name)).toEqual(['raw.ret1']);
    expect(report.skippedFactors).toEqual([
      { name: 'raw.fundingRate', category: 'raw', reason: 'no finite pairs at any horizon' },
    ]);
  }, 30_000);

  it('is deterministic: two runs with the same seed write identical files (ignoring computedAt)', async () => {
    const outA = join(dir, 'reports', 'a.json');
    const outB = join(dir, 'reports', 'b.json');

    const argsA = parseArgs([
      '--interval', INTERVAL,
      '--dataset-dir', dir,
      '--factors', 'raw.ret1,raw.rsi',
      '--bootstrap-n', '100',
      '--allow-lockbox',
      '--task-id', 'det-test',
      '--out', outA,
    ]);
    const argsB: FactorIcArgs = { ...argsA, out: outB };

    await runFactorIc(argsA);
    await runFactorIc(argsB);

    const a = JSON.parse(readFileSync(outA, 'utf8'));
    const b = JSON.parse(readFileSync(outB, 'utf8'));
    delete a.computedAt;
    delete b.computedAt;

    expect(a).toEqual(b);
  }, 30_000);

  it('--cell prints (and returns) the same ic and n as the per-symbol table entry', async () => {
    const baseArgs = parseArgs([
      '--interval', INTERVAL,
      '--dataset-dir', dir,
      '--factors', 'raw.ret1,raw.rsi',
      '--bootstrap-n', '100',
      '--allow-lockbox',
      '--out', join(dir, 'reports', 'report.json'),
    ]);
    const report = await buildFactorIcReport(baseArgs);

    const symbol = SYMBOLS[0];
    const cellArgs: FactorIcArgs = { ...baseArgs, cell: { factor: 'raw.ret1', horizon: 1, symbol } };
    const cell = await runCell(cellArgs);

    const expected = report.factors
      .find((f) => f.name === 'raw.ret1')!
      .perSymbol.find((p) => p.symbol === symbol)!
      .horizons.find((h) => h.horizon === 1)!;

    expect(cell.factor).toBe('raw.ret1');
    expect(cell.horizon).toBe(1);
    expect(cell.symbol).toBe(symbol);
    expect(cell.ic).toBeCloseTo(expected.ic, 9);
    expect(cell.n).toBe(expected.n);
  }, 30_000);

  it('--cell without a symbol matches the pooled table entry', async () => {
    const baseArgs = parseArgs([
      '--interval', INTERVAL,
      '--dataset-dir', dir,
      '--factors', 'raw.ret1,raw.rsi',
      '--bootstrap-n', '100',
      '--allow-lockbox',
      '--out', join(dir, 'reports', 'report.json'),
    ]);
    const report = await buildFactorIcReport(baseArgs);

    const cellArgs: FactorIcArgs = { ...baseArgs, cell: { factor: 'raw.ret1', horizon: 1 } };
    const cell = await runCell(cellArgs);

    const expected = report.factors.find((f) => f.name === 'raw.ret1')!.pooled.horizons.find((h) => h.horizon === 1)!;

    expect(cell.symbol).toBeUndefined();
    expect(cell.ic).toBeCloseTo(expected.ic, 9);
    expect(cell.n).toBe(expected.n);
  }, 30_000);

  it('throws when the dataset manifest has been tampered with', async () => {
    const candlePath = join(dir, 'candles', SYMBOLS[0], `${INTERVAL}.jsonl.gz`);
    writeFileSync(candlePath, Buffer.concat([readFileSync(candlePath), Buffer.from([0])]));

    const args = parseArgs(['--interval', INTERVAL, '--dataset-dir', dir]);
    await expect(buildFactorIcReport(args)).rejects.toThrow();
  });

  it('throws when a requested factor does not exist', async () => {
    const args = parseArgs([
      '--interval', INTERVAL,
      '--dataset-dir', dir,
      '--factors', 'raw.doesNotExist',
      '--allow-lockbox',
    ]);
    await expect(buildFactorIcReport(args)).rejects.toThrow(/raw\.doesNotExist/);
  });

  it('--cell throws a clear error for a factor absent from every symbol (pooled)', async () => {
    const args = parseArgs(['--interval', INTERVAL, '--dataset-dir', dir, '--allow-lockbox']);
    const cellArgs: FactorIcArgs = { ...args, cell: { factor: 'raw.doesNotExist', horizon: 1 } };
    await expect(runCell(cellArgs)).rejects.toThrow(/raw\.doesNotExist/);
  });

  it('--cell throws a clear error for a factor absent from the named symbol', async () => {
    const args = parseArgs(['--interval', INTERVAL, '--dataset-dir', dir, '--allow-lockbox']);
    const cellArgs: FactorIcArgs = { ...args, cell: { factor: 'raw.doesNotExist', horizon: 1, symbol: SYMBOLS[0] } };
    await expect(runCell(cellArgs)).rejects.toThrow(/raw\.doesNotExist/);
  });

  it('throws when --expect-manifest-hash does not match the loaded dataset', async () => {
    const args = parseArgs([
      '--interval', INTERVAL,
      '--dataset-dir', dir,
      '--allow-lockbox',
      '--expect-manifest-hash', 'not-the-real-hash',
    ]);
    await expect(buildFactorIcReport(args)).rejects.toThrow(/manifest hash/i);
  });

  it('succeeds when --expect-manifest-hash matches the loaded dataset', async () => {
    const manifest: DatasetManifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const args = parseArgs([
      '--interval', INTERVAL,
      '--dataset-dir', dir,
      '--factors', 'raw.ret1',
      '--allow-lockbox',
      '--expect-manifest-hash', manifest.datasetHash,
    ]);
    await expect(buildFactorIcReport(args)).resolves.toBeDefined();
  });

  it('throws when a dataset is internally misaligned (htf shorter than candles) even though its manifest verifies', async () => {
    // A dataset that is internally self-consistent w.r.t. its OWN recorded
    // hashes (verifyManifest passes) but whose htf file has fewer rows than
    // its candle file -- the scenario verifyManifest's per-file hash check
    // cannot catch, since it only detects a file that no longer matches its
    // own recorded sha256, not a file that is wrong relative to another file.
    const symbol = SYMBOLS[0];
    const htfPath = join(dir, 'htf', symbol, `${INTERVAL}.jsonl.gz`);
    const { readJsonlGz } = await import('./dataset-format');
    const fullHtfRows = readJsonlGz<HtfRow>(htfPath);
    const truncatedHtfRows = fullHtfRows.slice(0, -1);

    await writeJsonlGz(htfPath, truncatedHtfRows);
    const newSha256 = await sha256File(htfPath);

    const manifest: DatasetManifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const htfFile = manifest.files.find((f) => f.kind === 'htf' && f.symbol === symbol)!;
    htfFile.sha256 = newSha256;
    htfFile.rowCount = truncatedHtfRows.length;
    htfFile.endMs = truncatedHtfRows[truncatedHtfRows.length - 1].t;
    manifest.datasetHash = datasetHashOf(manifest.files);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const args = parseArgs(['--interval', INTERVAL, '--dataset-dir', dir, '--allow-lockbox']);
    await expect(buildFactorIcReport(args)).rejects.toThrow(/htf/i);
  });

  it('--cell --report reproduces the report per-symbol ic and n, ignoring conflicting CLI flags', async () => {
    const reportPath = join(dir, 'reports', 'report.json');
    const baseArgs = parseArgs([
      '--interval', INTERVAL,
      '--dataset-dir', dir,
      '--factors', 'raw.ret1,raw.rsi',
      '--bootstrap-n', '100',
      '--allow-lockbox',
      '--out', reportPath,
    ]);
    const report = await runFactorIc(baseArgs);

    const symbol = SYMBOLS[0];
    const expected = report.factors
      .find((f) => f.name === 'raw.ret1')!
      .perSymbol.find((p) => p.symbol === symbol)!
      .horizons.find((h) => h.horizon === 1)!;

    // Deliberately conflicting flags (a different symbols/lockbox setting):
    // --report must win, per the brief ("the CLI flags may not override them").
    const cellArgs = parseArgs([
      '--interval', INTERVAL,
      '--dataset-dir', dir,
      '--symbols', SYMBOLS[1],
      '--cell', `raw.ret1:1:${symbol}`,
      '--report', reportPath,
    ]);
    const cell = await runCell(cellArgs);

    expect(cell.ic).toBeCloseTo(expected.ic, 9);
    expect(cell.n).toBe(expected.n);
  }, 30_000);
});

describe('parseArgs', () => {
  const NOW = new Date(Date.UTC(2026, 8, 17, 15, 30));

  it('applies defaults', () => {
    const args = parseArgs(['--interval', '1h'], NOW);

    expect(args.interval).toBe('1h');
    expect(args.symbols).toBeUndefined();
    expect(args.horizons).toEqual([1, 2, 4, 8, 16, 32]);
    expect(args.datasetDir).toBe('data/research');
    expect(args.bootstrapN).toBe(200);
    expect(args.bootstrapSeed).toBe(42);
    expect(args.bootstrapPerSymbol).toBe(false);
    expect(args.bootstrapMaxPairs).toBe(100_000);
    expect(args.allowLockbox).toBe(false);
    expect(args.factors).toBeUndefined();
    expect(args.cell).toBeUndefined();
    expect(args.expectManifestHash).toBeUndefined();
    expect(args.reportPath).toBeUndefined();
    expect(args.taskId).toBe('factor-ic-1h-202609171530');
    expect(args.out).toBe('data/research/reports/factor-ic-1h-factor-ic-1h-202609171530.json');
  });

  it('parses comma-separated symbols, horizons, and factors', () => {
    const args = parseArgs(
      ['--interval', '4h', '--symbols', 'BTCUSDT,ETHUSDT', '--horizons', '1,3,9', '--factors', 'raw.ret1,raw.rsi'],
      NOW
    );

    expect(args.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(args.horizons).toEqual([1, 3, 9]);
    expect(args.factors).toEqual(['raw.ret1', 'raw.rsi']);
  });

  it('parses --cell in both factor:horizon and factor:horizon:symbol forms', () => {
    const pooled = parseArgs(['--interval', '1h', '--cell', 'raw.ret1:4'], NOW);
    expect(pooled.cell).toEqual({ factor: 'raw.ret1', horizon: 4 });

    const perSymbol = parseArgs(['--interval', '1h', '--cell', 'raw.ret1:4:BTCUSDT'], NOW);
    expect(perSymbol.cell).toEqual({ factor: 'raw.ret1', horizon: 4, symbol: 'BTCUSDT' });
  });

  it('sets boolean flags true on presence alone, without consuming the next arg', () => {
    const args = parseArgs(['--interval', '1h', '--allow-lockbox', '--bootstrap-per-symbol', '--horizons', '1,2'], NOW);
    expect(args.allowLockbox).toBe(true);
    expect(args.bootstrapPerSymbol).toBe(true);
    expect(args.horizons).toEqual([1, 2]);
  });

  it('parses an explicit --bootstrap-n and --bootstrap-max-pairs', () => {
    const args = parseArgs(['--interval', '1h', '--bootstrap-n', '50', '--bootstrap-max-pairs', '1000'], NOW);
    expect(args.bootstrapN).toBe(50);
    expect(args.bootstrapMaxPairs).toBe(1000);
  });

  it('parses ISO --start and --end into epoch milliseconds', () => {
    const args = parseArgs(
      ['--interval', '1h', '--start', '2026-01-01T00:00:00.000Z', '--end', '2026-02-01T00:00:00.000Z'],
      NOW
    );
    expect(args.start).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(args.end).toBe(Date.parse('2026-02-01T00:00:00.000Z'));
  });

  it('honors an explicit --task-id and --out', () => {
    const args = parseArgs(['--interval', '1h', '--task-id', 'custom-id', '--out', '/tmp/x.json'], NOW);
    expect(args.taskId).toBe('custom-id');
    expect(args.out).toBe('/tmp/x.json');
  });

  it('throws when --interval is missing', () => {
    expect(() => parseArgs([], NOW)).toThrow();
  });

  it('throws on an unparseable --start date', () => {
    expect(() => parseArgs(['--interval', '1h', '--start', 'not-a-date'], NOW)).toThrow();
  });

  it('throws on a malformed --cell value', () => {
    expect(() => parseArgs(['--interval', '1h', '--cell', 'onlyonepart'], NOW)).toThrow();
  });

  it('throws on a zero or negative --horizons value instead of hanging downstream', () => {
    expect(() => parseArgs(['--interval', '1h', '--horizons', '1,0,2'], NOW)).toThrow();
    expect(() => parseArgs(['--interval', '1h', '--horizons', '-4'], NOW)).toThrow();
  });

  it('throws on a non-integer --horizons value', () => {
    expect(() => parseArgs(['--interval', '1h', '--horizons', '1.5'], NOW)).toThrow();
  });

  it('throws on an unknown flag instead of silently swallowing its value', () => {
    expect(() => parseArgs(['--interval', '1h', '--totally-bogus-flag', 'value'], NOW)).toThrow(/bogus/);
  });

  it('parses --expect-manifest-hash and --report', () => {
    const args = parseArgs(
      ['--interval', '1h', '--expect-manifest-hash', 'abc123', '--report', '/tmp/report.json'],
      NOW
    );
    expect(args.expectManifestHash).toBe('abc123');
    expect(args.reportPath).toBe('/tmp/report.json');
  });
});
