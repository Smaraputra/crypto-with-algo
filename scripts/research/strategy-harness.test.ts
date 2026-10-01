// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  type OptionsRow,
  type SnapshotRow,
} from './dataset-format';
import { validateStrategyReport, type StrategyReport } from './report-schema';
import { ALL_FAMILIES } from './exploration-families';
import {
  costsForSymbolReport,
  parseArgs,
  runCell,
  runStrategyHarness,
  type StrategyHarnessArgs,
} from './strategy-harness';

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
  /** When true, writes an hourly BTC options-flow file (options/BTC/1h.jsonl.gz,
   * currency-keyed, not per-symbol -- read by every symbol as the market-wide
   * reading, per strategy-harness.ts's loadMarketOptions) spanning the
   * fixture's full candle range plus warmup, with distinct finite values so
   * mktDvolZ30/mktOptSkew24/mktOptGammaFlow24Z/mktOptDeltaFlow24Z can
   * actually populate. */
  options?: boolean;
}

const OPTIONS_HOUR_MS = 3_600_000;

/** One synthetic hourly options row, everything finite so the sum/mean/z
 * columns all have something to work with. Mirrors factor-ic.test.ts's
 * optionsRow fixture helper. */
function optionsRow(h: number): OptionsRow {
  return {
    t: START + h * OPTIONS_HOUR_MS,
    dvolOpen: 55 + Math.sin(h / 11) * 10,
    dvolHigh: 56 + Math.sin(h / 11) * 10,
    dvolLow: 54 + Math.sin(h / 11) * 10,
    dvolClose: 55 + Math.sin(h / 11) * 10,
    callBuyNotional: 1_000_000 + h * 100,
    callSellNotional: 900_000 + h * 90,
    putBuyNotional: 800_000 + h * 80,
    putSellNotional: 700_000 + h * 70,
    netDelta: (h % 13) - 6,
    netDollarGamma: Math.sin(h / 9) * 20,
    tradeCount: 20 + h,
    greekTradeCount: 10 + h,
    vwIv: 60,
    putIv25: 60 + (h % 5),
    callIv25: 58 + (h % 7),
  };
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

  if (opts.options) {
    // Currency-keyed, not per-symbol: one file, read by every symbol as the
    // market-wide reading (strategy-harness.ts's loadMarketOptions always
    // reads options/BTC/1h.jsonl.gz regardless of which symbol is running).
    const optionsHours = Math.ceil((opts.count * opts.stepMs) / OPTIONS_HOUR_MS) + 24;
    const optionsRows: OptionsRow[] = Array.from({ length: optionsHours }, (_, h) => optionsRow(h));
    const optionsPath = join(dir, 'options', 'BTC', '1h.jsonl.gz');
    await writeJsonlGz(optionsPath, optionsRows);
    files.push({
      path: 'options/BTC/1h.jsonl.gz',
      kind: 'options',
      symbol: 'BTCUSDT',
      interval: '1h',
      rowCount: optionsRows.length,
      startMs: optionsRows[0].t,
      endMs: optionsRows[optionsRows.length - 1].t,
      sha256: await sha256File(optionsPath),
    });
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

    it('defaults feeProfile to standard and carries matching per-symbol costs', async () => {
      const { args } = await runBase();
      const report = await runStrategyHarness(args);

      expect(report.feeProfile).toBe('standard');
      expect(report.costs.takerFeePercent).toBeCloseTo(0.0005, 10);
      expect(report.costs.makerFeePercent).toBeCloseTo(0.0002, 10);
      for (const p of report.perSymbol) {
        expect(p.costs).toEqual({
          feePercent: report.costs.feePercent,
          makerFeePercent: report.costs.makerFeePercent,
          takerFeePercent: report.costs.takerFeePercent,
          slippageBps: report.costs.slippageBps,
        });
      }
    }, 30_000);

    it('threads --fee-profile through to the top-level and per-symbol costs', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const args = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--fee-profile', 'bnb',
        '--out', join(dir, 'reports', 'report.json'),
      ]);
      const report = await runStrategyHarness(args);

      expect(report.feeProfile).toBe('bnb');
      expect(report.costs.takerFeePercent).toBeCloseTo(0.00045, 10);
      expect(report.costs.makerFeePercent).toBeCloseTo(0.00018, 10);
      expect(report.perSymbol).toHaveLength(2);
      for (const p of report.perSymbol) {
        expect(p.costs?.takerFeePercent).toBeCloseTo(0.00045, 10);
        expect(p.costs?.makerFeePercent).toBeCloseTo(0.00018, 10);
      }
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

    it('reproduces a report generated under a non-default --fee-profile, via costsForSymbolReport', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const outPath = join(dir, 'reports', 'report.json');
      const baseArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--fee-profile', 'bnb',
        '--out', outPath,
      ]);
      const report = await runStrategyHarness(baseArgs);

      const symbol = report.symbols[0];
      const window0 = report.perSymbol.find((p) => p.symbol === symbol)!.windows[0];
      expect(window0.oos).not.toBeNull();

      // No --fee-profile on the cell args: runCell must read costs from the
      // report itself (costsForSymbolReport), not from the CLI's own default.
      const cellArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--cell', `${symbol}:0`,
        '--report', outPath,
      ]);
      const cell = await runCell(cellArgs);

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

      // Mark a window skipped in the report on disk rather than relying on the
      // fixture to produce one. This previously searched for a naturally
      // skipped window, with a comment pinning it to "ETHUSDT's window 1 ...
      // with this fixture's fixed seed" -- which made the test depend on
      // incidental score values, and it broke the moment the scorer changed
      // (correctly) and every window started reaching minIsTrades. The
      // behaviour under test is runCell's refusal, not the fixture's arithmetic.
      // Same technique as the stale-manifest test above.
      const target = { symbol: report.perSymbol[0].symbol, index: report.perSymbol[0].windows[0].index };
      const patched = {
        ...report,
        perSymbol: report.perSymbol.map((p, i) =>
          i === 0
            ? { ...p, windows: p.windows.map((w, j) => (j === 0 ? { ...w, selectedParams: null } : w)) }
            : p
        ),
      };
      writeFileSync(outPath, JSON.stringify(patched, null, 2));

      const skippedEntry = { symbol: target.symbol, window: { index: target.index } };

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

  describe('runStrategyHarness: options file', () => {
    it('loads BTC options once and passes them to every symbol', async () => {
      await buildFixtureDataset(dir, {
        interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h', options: true,
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const args = parseArgs([
          '--family', 'control',
          '--interval', '1h',
          '--dataset-dir', dir,
          '--windows', '3',
          '--bootstrap-n', '20',
          '--benchmark-n', '10',
          '--out', join(dir, 'reports', 'report.json'),
        ]);
        const report = await runStrategyHarness(args);

        // loadMarketOptions is called once per run, not once per symbol; its
        // "no BTC options file" warning (strategy-harness.ts) must never
        // fire when the file is present, for either symbol, and every
        // symbol must still complete (nothing silently dropped).
        const warned = errorSpy.mock.calls.some((call) => String(call[0]).includes('no BTC options file'));
        expect(warned).toBe(false);
        expect(report.perSymbol.map((p) => p.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
      } finally {
        errorSpy.mockRestore();
      }
    }, 30_000);

    it('runs with a warning and NaN columns when the options file is absent', async () => {
      // The base fixture (no `options: true`) writes no options file at all.
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const args = parseArgs([
          '--family', 'control',
          '--interval', '1h',
          '--dataset-dir', dir,
          '--windows', '3',
          '--bootstrap-n', '20',
          '--benchmark-n', '10',
          '--out', join(dir, 'reports', 'report.json'),
        ]);
        const report = await runStrategyHarness(args);

        const warned = errorSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            'no BTC options file; mktDvolZ30/mktOptSkew24/mktOptGammaFlow24Z/mktOptDeltaFlow24Z will be NaN for every symbol'
          )
        );
        expect(warned).toBe(true);
        // Absent options data is not fatal: the run still completes normally.
        expect(report.gates).toHaveLength(8);
      } finally {
        errorSpy.mockRestore();
      }
    }, 30_000);

    it('--cell --report reproduces a run that read the options file', async () => {
      await buildFixtureDataset(dir, {
        interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h', options: true,
      });
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
      const window0 = report.perSymbol.find((p) => p.symbol === symbol)!.windows[0];
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
  });

  describe('--fix-params', () => {
    it('collapses the grid to the matching cell and records fixedParams', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const args = parseArgs([
        '--family', 'return-reversal',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--fix-params', 'L=5,Z=2,H=8',
        '--out', join(dir, 'reports', 'report.json'),
      ]);
      const report = await runStrategyHarness(args);

      expect(report.gridCells).toBe(1);
      expect(report.fixedParams).toEqual({ L: 5, Z: 2, H: 8 });
      for (const p of report.perSymbol) {
        for (const w of p.windows) {
          if (w.selectedParams !== null) {
            expect(w.selectedParams).toEqual({ L: 5, Z: 2, H: 8 });
          }
        }
      }
    }, 30_000);

    it('rejects an unknown name and a value not in the grid', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });

      const badName = parseArgs([
        '--family', 'return-reversal',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--fix-params', 'bogus=5,Z=2,H=8',
        '--out', join(dir, 'reports', 'a.json'),
      ]);
      await expect(runStrategyHarness(badName)).rejects.toThrow(/bogus/);

      const badValue = parseArgs([
        '--family', 'return-reversal',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--fix-params', 'L=999,Z=2,H=8',
        '--out', join(dir, 'reports', 'b.json'),
      ]);
      await expect(runStrategyHarness(badValue)).rejects.toThrow(/matches no cell/);
    }, 30_000);
  });

  describe('--allowed-sessions', () => {
    it('rejects an unknown session and reaches the config of the walk-forward and the benchmark', async () => {
      expect(() =>
        parseArgs(['--family', 'control', '--interval', '1h', '--allowed-sessions', 'asia,bogus'])
      ).toThrow(/Unknown --allowed-sessions "bogus"/);

      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });

      const unrestrictedArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--out', join(dir, 'reports', 'unrestricted.json'),
      ]);
      const restrictedArgs = parseArgs([
        '--family', 'control',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--allowed-sessions', 'ny_overlap',
        '--out', join(dir, 'reports', 'restricted.json'),
      ]);

      const unrestricted = await runStrategyHarness(unrestrictedArgs);
      const restricted = await runStrategyHarness(restrictedArgs);

      expect(restricted.allowedSessions).toEqual(['ny_overlap']);
      expect(unrestricted.allowedSessions).toBeUndefined();
      // The session gate is subtractive-only (bar-loop.ts only skips entries
      // outside the allowed set, never adds one), so restricting to a single
      // 4-hour session out of 24 can only reduce the pooled trade count. Both
      // runs complete through the benchmark and stress paths without error,
      // which they could not if allowedSessions were dropped anywhere those
      // paths build their own BacktestConfig (see strategy-walk-forward.ts).
      expect(restricted.pooled.n).toBeLessThanOrEqual(unrestricted.pooled.n);
    }, 30_000);
  });

  describe('--cell --report with --fix-params', () => {
    it('reproduces a fixed-params report', async () => {
      await buildFixtureDataset(dir, { interval: '1h', stepMs: 3_600_000, count: 1200, htfInterval: '4h' });
      const outPath = join(dir, 'reports', 'report.json');
      const baseArgs = parseArgs([
        '--family', 'return-reversal',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--windows', '3',
        '--bootstrap-n', '20',
        '--benchmark-n', '10',
        '--fix-params', 'L=5,Z=2,H=8',
        '--out', outPath,
      ]);
      const report = await runStrategyHarness(baseArgs);
      expect(report.fixedParams).toEqual({ L: 5, Z: 2, H: 8 });

      const symbol = report.symbols[0];
      const windows = report.perSymbol.find((p) => p.symbol === symbol)!.windows;
      const windowIndex = windows.findIndex((w) => w.oos !== null);
      expect(windowIndex, 'fixture must produce at least one traded window').toBeGreaterThanOrEqual(0);
      const window = windows[windowIndex];

      const cellArgs = parseArgs([
        '--family', 'return-reversal',
        '--interval', '1h',
        '--dataset-dir', dir,
        '--cell', `${symbol}:${windowIndex}`,
        '--report', outPath,
      ]);
      const cell = await runCell(cellArgs);

      expect(cell.trades).toBe(window.oos!.trades);
      expect(cell.expectancyPercent).toBeCloseTo(window.oos!.expectancyPercent!, 9);
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
    // 1 grid cell (control has no params) x every registered family. This
    // default moves whenever ANY family is added or removed (task 4 added
    // three *-managed families, 13 -> 16; see STRATEGY_FAMILIES's own
    // docstring), which is why every phase overrides it with an explicit
    // --trials fixed for the whole phase. Derived from the registry itself,
    // not a literal, so this assertion does not need editing the next time
    // the count changes.
    expect(args.trials).toBe(Object.keys(ALL_FAMILIES).length);
    expect(args.stressFeeMult).toBe(1.5);
    expect(args.stressSlippageMult).toBe(2);
    expect(args.feeProfile).toBe('standard');
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

  it('defaults --fee-profile to standard and validates the name', () => {
    expect(parseArgs(['--family', 'control', '--interval', '1h']).feeProfile).toBe('standard');
    expect(
      parseArgs(['--family', 'control', '--interval', '1h', '--fee-profile', 'promo-btc-eth-2026-07']).feeProfile
    ).toBe('promo-btc-eth-2026-07');
    expect(() => parseArgs(['--family', 'control', '--interval', '1h', '--fee-profile', 'vip9'])).toThrow(
      /Unknown --fee-profile/
    );
  });
});

describe('costsForSymbolReport', () => {
  it('prefers the per-symbol block and falls back to the report costs', () => {
    const report = {
      costs: { feePercent: 0.0005, makerFeePercent: 0.0002, takerFeePercent: 0.0005, slippageBps: 3, fundingEnabled: false },
      perSymbol: [
        { symbol: 'BTCUSDT', costs: { feePercent: 0.00036, makerFeePercent: 0, takerFeePercent: 0.00036, slippageBps: 3 } },
        { symbol: 'SOLUSDT' },
      ],
    } as unknown as StrategyReport;
    expect(costsForSymbolReport(report, 'BTCUSDT').makerFeePercent).toBe(0);
    expect(costsForSymbolReport(report, 'SOLUSDT').makerFeePercent).toBe(0.0002);
  });
});
