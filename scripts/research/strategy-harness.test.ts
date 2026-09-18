// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { intervalToMs } from '@/lib/intervals';
import {
  LOCKBOX_START_ISO,
  datasetHashOf,
  sha256File,
  writeJsonlGz,
  type CandleRow,
  type DatasetManifest,
  type ManifestFile,
  type SnapshotRow,
} from './dataset-format';
import { validateStrategyReport } from './report-schema';
import { parseArgs, runCell, runStrategyHarness, type StrategyHarnessArgs } from './strategy-harness';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const START = Date.UTC(2025, 0, 1);

// Deterministic LCG matching the pattern used elsewhere in this repo's tests
// (e.g. factor-ic.test.ts, strategy-walk-forward.test.ts).
function makeLcg(seed: number): () => number {
  let state = seed;
  return function next(): number {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

/**
 * A choppy sine-driven trend (period 10 bars) plus noise: wide enough swings
 * for the real composite score-threshold strategy (control family) to cross
 * its +-24 entry threshold often enough to clear minIsTrades (10) within a
 * single ~280-bar in-sample training window, at every one of the three
 * out-of-sample windows this file's fixtures use. A slower/calmer walk (a
 * single monotonic drift, or a longer sine period) was tried first and
 * produced only 5-6 in-sample trades per window -- under minIsTrades, so
 * every window came back skipped.
 */
function generateCandleRows(count: number, seed: number, startMs: number, stepMs: number): CandleRow[] {
  const next = makeLcg(seed);
  const rows: CandleRow[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 10) * 0.006;
    const noise = (next() - 0.5) * 1.2;
    price = price * (1 + drift + noise / 100);
    const high = price * (1 + next() * 0.006);
    const low = price * (1 - next() * 0.006);
    const open = price * (1 + (next() - 0.5) * 0.004);
    const volume = 1000 + next() * 5000;
    rows.push({
      t: startMs + i * stepMs,
      o: open,
      h: high,
      l: low,
      c: price,
      v: volume,
      tbv: volume * (0.3 + next() * 0.4),
    });
  }
  return rows;
}

interface FixtureOptions {
  interval: string;
  stepMs: number;
  count: number;
  htfInterval?: string;
  snapshotRowsPerSymbol?: Record<string, number>;
  snapshotInterval?: string;
  /** Overrides the default oscillating funding rate (0.0001 * ((k % 3) - 1),
   * zero for a third of rows) with a fixed non-zero rate for every row. */
  fundingRate?: number;
}

/**
 * Two symbols' worth of candles at `interval`, an optional HTF candle file,
 * and a snapshot file per symbol (empty unless snapshotRowsPerSymbol says
 * otherwise), plus a manifest with real hashes. Mirrors factor-ic.test.ts's
 * fixture-building approach.
 */
async function buildFixtureDataset(dir: string, opts: FixtureOptions): Promise<DatasetManifest> {
  const files: ManifestFile[] = [];
  const snapshotInterval = opts.snapshotInterval ?? opts.interval;
  const intervals = new Set([opts.interval, snapshotInterval]);
  if (opts.htfInterval) intervals.add(opts.htfInterval);

  for (const [i, symbol] of SYMBOLS.entries()) {
    const candleRows = generateCandleRows(opts.count, 4242 + i * 1000, START, opts.stepMs);
    const candlePath = join(dir, 'candles', symbol, `${opts.interval}.jsonl.gz`);
    await writeJsonlGz(candlePath, candleRows);
    files.push({
      path: `candles/${symbol}/${opts.interval}.jsonl.gz`,
      kind: 'candles',
      symbol,
      interval: opts.interval,
      rowCount: candleRows.length,
      startMs: candleRows[0].t,
      endMs: candleRows[candleRows.length - 1].t,
      sha256: await sha256File(candlePath),
    });

    const rowCount = opts.snapshotRowsPerSymbol?.[symbol] ?? 0;
    const snapshotStepMs = intervalToMs(snapshotInterval);
    const snapshotRows: SnapshotRow[] = Array.from({ length: rowCount }, (_, k) => ({
      t: START + k * snapshotStepMs,
      fundingRate: { rate: opts.fundingRate ?? 0.0001 * ((k % 3) - 1), markPrice: 100 + k },
      longShortRatio: null,
      openInterest: null,
      fearGreed: null,
      newsSentiment: null,
    }));
    const snapshotPath = join(dir, 'snapshots', symbol, `${snapshotInterval}.jsonl.gz`);
    await writeJsonlGz(snapshotPath, snapshotRows);
    files.push({
      path: `snapshots/${symbol}/${snapshotInterval}.jsonl.gz`,
      kind: 'snapshots',
      symbol,
      interval: snapshotInterval,
      rowCount: snapshotRows.length,
      startMs: snapshotRows.length > 0 ? snapshotRows[0].t : null,
      endMs: snapshotRows.length > 0 ? snapshotRows[snapshotRows.length - 1].t : null,
      sha256: await sha256File(snapshotPath),
    });

    if (opts.htfInterval) {
      const htfStepMs = intervalToMs(opts.htfInterval);
      const warmupBars = 100;
      const htfCount = warmupBars + Math.ceil((opts.count * opts.stepMs) / htfStepMs) + 5;
      const htfStart = START - warmupBars * htfStepMs;
      const htfRows = generateCandleRows(htfCount, 9000 + i * 1000, htfStart, htfStepMs);
      const htfPath = join(dir, 'candles', symbol, `${opts.htfInterval}.jsonl.gz`);
      await writeJsonlGz(htfPath, htfRows);
      files.push({
        path: `candles/${symbol}/${opts.htfInterval}.jsonl.gz`,
        kind: 'candles',
        symbol,
        interval: opts.htfInterval,
        rowCount: htfRows.length,
        startMs: htfRows[0].t,
        endMs: htfRows[htfRows.length - 1].t,
        sha256: await sha256File(htfPath),
      });
    }
  }

  const manifest: DatasetManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    commit: 'test-fixture',
    lockboxStart: LOCKBOX_START_ISO,
    symbols: SYMBOLS,
    intervals: [...intervals],
    files,
    datasetHash: datasetHashOf(files),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

describe('strategy-harness CLI', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strategy-harness-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('runStrategyHarness: base fixture (1h, empty snapshots, htf present)', () => {
    async function runBase(): Promise<{ manifest: DatasetManifest; args: StrategyHarnessArgs; outPath: string }> {
      const manifest = await buildFixtureDataset(dir, {
        interval: '1h',
        stepMs: 3_600_000,
        count: 1200,
        htfInterval: '4h',
      });
      const outPath = join(dir, 'reports', 'report.json');
      const args = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '50',
        '--benchmark-n', '20',
        '--out', outPath,
      ]);
      return { manifest, args, outPath };
    }

    it('produces a schema-valid report with the eight gates in order', async () => {
      const { args } = await runBase();
      const report = await runStrategyHarness(args);

      const validated = validateStrategyReport(report);
      expect(validated.ok).toBe(true);

      expect(report.gates).toHaveLength(8);
      expect(report.gates.map((g) => g.name)).toEqual([
        'sample',
        'expectancy',
        'windows',
        'symbols',
        'timing',
        'trials',
        'plateau',
        'stress',
      ]);
    }, 30_000);

    it('reports fundingEnabled false and snapshotSource null with empty snapshot files', async () => {
      const { args } = await runBase();
      const report = await runStrategyHarness(args);

      expect(report.costs.fundingEnabled).toBe(false);
      expect(report.snapshotSource).toBeNull();
    }, 30_000);

    it('writes the report where --out says', async () => {
      const { args, outPath } = await runBase();
      const report = await runStrategyHarness(args);

      const written = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(written.taskId).toBe(report.taskId);
      expect(written.pooled.n).toBe(report.pooled.n);
    }, 30_000);

    it('produces real out-of-sample trades and a non-trivial pooled n', async () => {
      const { args } = await runBase();
      const report = await runStrategyHarness(args);

      expect(report.pooled.n).toBeGreaterThan(0);
      expect(report.perSymbol).toHaveLength(2);
      expect(report.family).toBe('control');
      expect(report.style).toBe('day_trading');
      expect(report.gridCells).toBe(1);
    }, 30_000);

    it('gives each symbol a distinct benchmark seed (base seed + symbolIndex * 1,000,000)', async () => {
      const { args } = await runBase();
      const report = await runStrategyHarness(args);

      expect(report.perSymbol).toHaveLength(2);
      expect(report.perSymbol[0].benchmarkSeed).toBe(args.seed);
      expect(report.perSymbol[1].benchmarkSeed).toBe(args.seed + 1_000_000);
      expect(report.perSymbol[0].benchmarkSeed).not.toBe(report.perSymbol[1].benchmarkSeed);
    }, 30_000);

    it('records a null benchmarkSeed for every symbol under --no-benchmark', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const args = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--no-benchmark',
        '--out', join(dir, 'reports', 'report.json'),
      ]);
      const report = await runStrategyHarness(args);

      for (const p of report.perSymbol) {
        expect(p.benchmarkSeed).toBeNull();
      }
    }, 30_000);

    it('lockboxApplied is false under --allow-lockbox, true otherwise', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });

      const withoutLockboxArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--out', join(dir, 'reports', 'a.json'),
      ]);
      const withLockboxArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--allow-lockbox',
        '--out', join(dir, 'reports', 'b.json'),
      ]);

      const reportWithout = await runStrategyHarness(withoutLockboxArgs);
      const reportWith = await runStrategyHarness(withLockboxArgs);

      expect(reportWithout.lockboxApplied).toBe(true);
      expect(reportWith.lockboxApplied).toBe(false);
    }, 30_000);

    it('throws when --expect-manifest-hash does not match the loaded dataset', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const args = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--expect-manifest-hash', 'not-the-real-hash',
        '--out', join(dir, 'reports', 'report.json'),
      ]);
      await expect(runStrategyHarness(args)).rejects.toThrow(/manifest hash/i);
    });

    it('succeeds when --expect-manifest-hash matches the loaded dataset', async () => {
      const manifest = await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const args = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--expect-manifest-hash', manifest.datasetHash,
        '--out', join(dir, 'reports', 'report.json'),
      ]);
      await expect(runStrategyHarness(args)).resolves.toBeDefined();
    }, 30_000);
  });

  describe('runCell', () => {
    it('reproduces window 0 of the first symbol exactly (trades and expectancyPercent)', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const outPath = join(dir, 'reports', 'report.json');
      const baseArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '50',
        '--benchmark-n', '20',
        '--out', outPath,
      ]);
      const report = await runStrategyHarness(baseArgs);

      const symbol = report.symbols[0];
      const window0 = report.perSymbol.find((p) => p.symbol === symbol)!.windows[0];
      expect(window0.selectedParams).not.toBeNull();
      expect(window0.oos).not.toBeNull();

      const cellArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--cell', `${symbol}:0`,
        '--report', outPath,
      ]);
      const cell = await runCell(cellArgs);

      expect(cell.symbol).toBe(symbol);
      expect(cell.window).toBe(0);
      expect(cell.trades).toBe(window0.oos!.trades);
      expect(cell.expectancyPercent).toBeCloseTo(window0.oos!.expectancyPercent!, 9);
    }, 30_000);

    it('reproduces the window without --family/--interval on the CLI, reading both from the report', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const outPath = join(dir, 'reports', 'report.json');
      const baseArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--out', outPath,
      ]);
      const report = await runStrategyHarness(baseArgs);
      const symbol = report.symbols[0];

      const cellArgs = parseArgs(['--dataset-dir', dir, '--cell', `${symbol}:0`, '--report', outPath]);
      expect(cellArgs.family).toBeUndefined();
      expect(cellArgs.interval).toBeUndefined();

      const cell = await runCell(cellArgs);
      const window0 = report.perSymbol.find((p) => p.symbol === symbol)!.windows[0];
      expect(cell.trades).toBe(window0.oos!.trades);
      expect(cell.expectancyPercent).toBeCloseTo(window0.oos!.expectancyPercent!, 9);
    }, 30_000);

    it('throws naming both values when --interval disagrees with the report', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const outPath = join(dir, 'reports', 'report.json');
      const baseArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--out', outPath,
      ]);
      const report = await runStrategyHarness(baseArgs);
      const symbol = report.symbols[0];

      const cellArgs = parseArgs([
        '--interval', '4h',
        '--dataset-dir', dir,
        '--cell', `${symbol}:0`,
        '--report', outPath,
      ]);
      await expect(runCell(cellArgs)).rejects.toThrow(/4h/);
      await expect(runCell(cellArgs)).rejects.toThrow(/1h/);
    }, 30_000);

    it('throws naming both values when --family disagrees with the report', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const outPath = join(dir, 'reports', 'report.json');
      const baseArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--out', outPath,
      ]);
      const report = await runStrategyHarness(baseArgs);
      const symbol = report.symbols[0];

      // A second, hypothetical family name is not registered, so use the
      // report's own family mutated in the written file to simulate a
      // disagreement without needing a second real STRATEGY_FAMILIES entry.
      const cellArgs: StrategyHarnessArgs = {
        ...parseArgs(['--dataset-dir', dir, '--cell', `${symbol}:0`, '--report', outPath]),
        family: 'not-control',
      };
      await expect(runCell(cellArgs)).rejects.toThrow(/not-control/);
      await expect(runCell(cellArgs)).rejects.toThrow(/control/);
    }, 30_000);

    it('throws when the dataset has changed since the report was written', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const outPath = join(dir, 'reports', 'report.json');
      const baseArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--out', outPath,
      ]);
      const report = await runStrategyHarness(baseArgs);

      // Rewrite the report to claim a dataset hash that does not match what
      // is actually on disk in `dir` (as if the dataset were re-exported
      // after this report was written).
      writeFileSync(outPath, JSON.stringify({ ...report, datasetManifestHash: 'stale-hash' }, null, 2));

      const cellArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--cell', `${report.symbols[0]}:0`,
        '--report', outPath,
      ]);
      await expect(runCell(cellArgs)).rejects.toThrow(/manifest hash/i);
    }, 30_000);

    it('throws when the window was skipped', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const outPath = join(dir, 'reports', 'report.json');
      const baseArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--out', outPath,
      ]);
      const report = await runStrategyHarness(baseArgs);

      // ETHUSDT's window 1 does not reach minIsTrades in sample with this
      // fixture's fixed seed (verified directly against this exact fixture);
      // deterministic given the fixed seeds this file uses throughout.
      const skippedEntry = report.perSymbol
        .flatMap((p) => p.windows.map((w) => ({ symbol: p.symbol, window: w })))
        .find((w) => w.window.selectedParams === null);
      expect(skippedEntry).toBeDefined();

      const cellArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--cell', `${skippedEntry!.symbol}:${skippedEntry!.window.index}`,
        '--report', outPath,
      ]);
      await expect(runCell(cellArgs)).rejects.toThrow(/skipped/);
    }, 30_000);
  });

  describe('runStrategyHarness: 5m interval with 1h snapshots', () => {
    it('records snapshotSource "1h" and fundingEnabled true when every symbol has funding rows', async () => {
      await buildFixtureDataset(dir, {
        interval: '5m',
        stepMs: 300_000,
        count: 1200,
        snapshotRowsPerSymbol: { BTCUSDT: 5, ETHUSDT: 5 },
        snapshotInterval: '1h',
      });
      const args = parseArgs([
        '--family', 'control',
        '--interval', '5m',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--out', join(dir, 'reports', 'report.json'),
      ]);
      const report = await runStrategyHarness(args);

      expect(report.snapshotSource).toBe('1h');
      expect(report.costs.fundingEnabled).toBe(true);
      expect(report.style).toBe('scalping');
    }, 30_000);

    it('accrues real funding cost and reports high snapshotCoveragePercent with hourly rows across the full span', async () => {
      // 1,200 5m bars = 6,000 minutes = 100 hours: one hourly snapshot row
      // per hour covers the whole candle span, unlike the 5-row "thin
      // coverage" fixture above, which never actually exercises 5m scoring
      // with real 1h funding data throughout the run.
      await buildFixtureDataset(dir, {
        interval: '5m',
        stepMs: 300_000,
        count: 1200,
        snapshotRowsPerSymbol: { BTCUSDT: 100, ETHUSDT: 100 },
        snapshotInterval: '1h',
        fundingRate: 0.0005,
      });
      const args = parseArgs([
        '--family', 'control',
        '--interval', '5m',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--out', join(dir, 'reports', 'report.json'),
      ]);
      const report = await runStrategyHarness(args);

      expect(report.costs.fundingEnabled).toBe(true);

      const allWindows = report.perSymbol.flatMap((p) => p.windows);
      const hasFundingCost = allWindows.some((w) => w.oos !== null && w.oos.fundingCost !== 0);
      expect(hasFundingCost).toBe(true);

      const highCoverageWindows = allWindows.filter(
        (w) => w.oos !== null && w.oos.snapshotCoveragePercent !== null && w.oos.snapshotCoveragePercent > 90
      );
      expect(highCoverageWindows.length).toBeGreaterThan(0);
    }, 30_000);
  });

  describe('runStrategyHarness: mixed snapshot coverage', () => {
    it('aborts naming the symbol with no snapshot rows', async () => {
      await buildFixtureDataset(dir, {
        interval: '1h',
        stepMs: 3_600_000,
        count: 1200,
        htfInterval: '4h',
        snapshotRowsPerSymbol: { BTCUSDT: 5 },
      });
      const args = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--out', join(dir, 'reports', 'report.json'),
      ]);
      await expect(runStrategyHarness(args)).rejects.toThrow(/ETHUSDT/);
    }, 30_000);
  });
});

describe('parseArgs', () => {
  const NOW = new Date(Date.UTC(2026, 8, 17, 15, 30));

  it('applies defaults', () => {
    const args = parseArgs(['--family', 'control', '--interval', '1h'], NOW);

    expect(args.family).toBe('control');
    expect(args.interval).toBe('1h');
    expect(args.symbols).toBeUndefined();
    expect(args.start).toBeUndefined();
    expect(args.end).toBeUndefined();
    expect(args.datasetDir).toBe('data/research');
    expect(args.windows).toBe(6);
    expect(args.trainFraction).toBe(0.4);
    expect(args.windowMode).toBe('rolling');
    expect(args.seed).toBe(42);
    expect(args.bootstrapN).toBe(1000);
    expect(args.benchmarkN).toBe(200);
    expect(args.noBenchmark).toBe(false);
    expect(args.trials).toBe(8); // 1 grid cell (control has no params) * 8 registered families
    expect(args.stressFeeMult).toBe(1.5);
    expect(args.stressSlippageMult).toBe(2);
    expect(args.allowLockbox).toBe(false);
    expect(args.expectManifestHash).toBeUndefined();
    expect(args.cell).toBeUndefined();
    expect(args.reportPath).toBeUndefined();
    expect(args.taskId).toBe('strategy-control-1h-202609171530');
    expect(args.out).toBe('data/research/reports/strategy-control-1h-strategy-control-1h-202609171530.json');
  });

  it('parses comma-separated symbols and ISO start/end', () => {
    const args = parseArgs(
      [
        '--family', 'control',
        '--interval', '4h',
        '--symbols', 'BTCUSDT,ETHUSDT',
        '--start', '2026-01-01T00:00:00.000Z',
        '--end', '2026-02-01T00:00:00.000Z',
      ],
      NOW
    );

    expect(args.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(args.start).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(args.end).toBe(Date.parse('2026-02-01T00:00:00.000Z'));
  });

  it('parses --cell as SYMBOL:WINDOW', () => {
    const args = parseArgs(['--family', 'control', '--interval', '1h', '--cell', 'BTCUSDT:3'], NOW);
    expect(args.cell).toEqual({ symbol: 'BTCUSDT', window: 3 });
  });

  it('sets boolean flags true on presence alone, without consuming the next arg', () => {
    const args = parseArgs(
      ['--family', 'control', '--interval', '1h', '--allow-lockbox', '--no-benchmark', '--windows', '4'],
      NOW
    );
    expect(args.allowLockbox).toBe(true);
    expect(args.noBenchmark).toBe(true);
    expect(args.windows).toBe(4);
  });

  it('honors an explicit --task-id and --out', () => {
    const args = parseArgs(
      ['--family', 'control', '--interval', '1h', '--task-id', 'custom-id', '--out', '/tmp/x.json'],
      NOW
    );
    expect(args.taskId).toBe('custom-id');
    expect(args.out).toBe('/tmp/x.json');
  });

  it('honors an explicit --window-mode of anchored, and rejects an invalid one', () => {
    const args = parseArgs(['--family', 'control', '--interval', '1h', '--window-mode', 'anchored'], NOW);
    expect(args.windowMode).toBe('anchored');
    expect(() => parseArgs(['--family', 'control', '--interval', '1h', '--window-mode', 'bogus'], NOW)).toThrow(
      /window-mode/
    );
  });

  it('honors an explicit --trials override', () => {
    const args = parseArgs(['--family', 'control', '--interval', '1h', '--trials', '42'], NOW);
    expect(args.trials).toBe(42);
  });

  it('throws on a non-finite numeric flag instead of producing NaN', () => {
    expect(() => parseArgs(['--family', 'control', '--interval', '1h', '--windows', 'oops'], NOW)).toThrow(
      /Invalid --windows: oops/
    );
  });

  it('throws on a non-integer value for an integer-only numeric flag', () => {
    expect(() => parseArgs(['--family', 'control', '--interval', '1h', '--seed', '1.5'], NOW)).toThrow(
      /Invalid --seed: 1.5/
    );
  });

  it('throws when --family is missing', () => {
    expect(() => parseArgs(['--interval', '1h'], NOW)).toThrow(/--family is required/);
  });

  it('throws on an unknown family, listing the known ones', () => {
    expect(() => parseArgs(['--family', 'bogus-family', '--interval', '1h'], NOW)).toThrow(/control/);
  });

  it('throws when --interval is missing', () => {
    expect(() => parseArgs(['--family', 'control'], NOW)).toThrow(/--interval is required/);
  });

  it('does not require --family/--interval when both --cell and --report are present', () => {
    const args = parseArgs(['--cell', 'BTCUSDT:0', '--report', '/tmp/report.json'], NOW);
    expect(args.family).toBeUndefined();
    expect(args.interval).toBeUndefined();
    expect(args.cell).toEqual({ symbol: 'BTCUSDT', window: 0 });
    expect(args.reportPath).toBe('/tmp/report.json');
  });

  it('still requires --family when --cell is given without --report', () => {
    expect(() => parseArgs(['--cell', 'BTCUSDT:0'], NOW)).toThrow(/--family is required/);
  });

  it('still requires --interval when --report is given without --cell', () => {
    expect(() => parseArgs(['--family', 'control', '--report', '/tmp/report.json'], NOW)).toThrow(
      /--interval is required/
    );
  });

  it('still validates an explicitly-passed --family even in cell mode', () => {
    expect(() =>
      parseArgs(['--family', 'bogus-family', '--cell', 'BTCUSDT:0', '--report', '/tmp/report.json'], NOW)
    ).toThrow(/control/);
  });

  it('throws on an unknown flag instead of silently swallowing its value', () => {
    expect(() =>
      parseArgs(['--family', 'control', '--interval', '1h', '--totally-bogus-flag', 'value'], NOW)
    ).toThrow(/bogus/);
  });

  it('throws on a malformed --cell value', () => {
    expect(() => parseArgs(['--family', 'control', '--interval', '1h', '--cell', 'onlyonepart'], NOW)).toThrow();
  });

  it('parses --expect-manifest-hash and --report', () => {
    const args = parseArgs(
      ['--family', 'control', '--interval', '1h', '--expect-manifest-hash', 'abc123', '--report', '/tmp/report.json'],
      NOW
    );
    expect(args.expectManifestHash).toBe('abc123');
    expect(args.reportPath).toBe('/tmp/report.json');
  });
});
