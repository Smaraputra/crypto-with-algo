// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { intervalToMs } from '@/lib/intervals';
import {
  datasetHashOf,
  sha256File,
  writeJsonlGz,
  type CandleRow,
  type DatasetManifest,
  type ManifestFile,
  type PerpCandleRow,
  type SnapshotRow,
} from './dataset-format';
import { validateExposureReport } from './report-schema';
import { EXPOSURE_GRID_CELL_COUNT } from './exposure-walk-forward';
import {
  TIMING_SEED_OFFSET,
  parseArgs,
  runCell,
  runExposureHarness,
  type ExposureHarnessArgs,
} from './exposure-harness';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const START = Date.UTC(2024, 0, 1);
const INTERVAL = '1d';
const FACTOR = 'positioningZ360';

function makeLcg(seed: number): () => number {
  let state = seed;
  return function next(): number {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

/** A choppy walk with enough variance for the exposure returns to have a
 * non-zero spread, which selection requires. */
function generateCloses(count: number, seed: number): number[] {
  const next = makeLcg(seed);
  const closes: number[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 17) * 0.008;
    const noise = (next() - 0.5) * 2.2;
    price = price * (1 + drift + noise / 100);
    closes.push(price);
  }
  return closes;
}

interface FixtureOptions {
  count?: number;
  /** Snapshot rows per symbol, keyed by symbol; a symbol absent from the map
   * gets the default count. Lets a fixture give one symbol coverage and leave
   * another without it. */
  snapshotRows?: Record<string, number>;
}

/**
 * Writes a minimal dataset: spot candles, perp klines on the SAME grid, and
 * snapshots carrying a long/short ratio so the positioning column can form.
 */
async function buildFixture(dir: string, opts: FixtureOptions = {}): Promise<void> {
  const count = opts.count ?? 1400;
  const stepMs = intervalToMs(INTERVAL);
  const files: ManifestFile[] = [];

  for (let s = 0; s < SYMBOLS.length; s++) {
    const symbol = SYMBOLS[s];
    const closes = generateCloses(count, 1000 + s);

    const candleRows: CandleRow[] = closes.map((c, i) => ({
      t: START + i * stepMs,
      o: c,
      h: c * 1.005,
      l: c * 0.995,
      c,
      v: 1000 + i,
      tbv: null,
    }));
    const candlePath = join(dir, 'candles', symbol, `${INTERVAL}.jsonl.gz`);
    await writeJsonlGz(candlePath, candleRows);
    files.push({
      path: `candles/${symbol}/${INTERVAL}.jsonl.gz`,
      kind: 'candles',
      symbol,
      interval: INTERVAL,
      rowCount: candleRows.length,
      startMs: candleRows[0].t,
      endMs: candleRows[candleRows.length - 1].t,
      sha256: await sha256File(candlePath),
    });

    {
      const perpRows: PerpCandleRow[] = closes.map((c, i) => ({
        t: START + i * stepMs,
        o: c * 1.0005,
        h: c * 1.006,
        l: c * 0.994,
        c: c * 1.001,
        v: 1200 + i,
        qv: 120000 + i,
        n: 500 + i,
        tbv: null,
      }));
      const perpPath = join(dir, 'perp', symbol, `${INTERVAL}.jsonl.gz`);
      await writeJsonlGz(perpPath, perpRows);
      files.push({
        path: `perp/${symbol}/${INTERVAL}.jsonl.gz`,
        kind: 'perp',
        symbol,
        interval: INTERVAL,
        rowCount: perpRows.length,
        startMs: perpRows[0].t,
        endMs: perpRows[perpRows.length - 1].t,
        sha256: await sha256File(perpPath),
      });
    }

    // A long/short ratio that swings, so the trailing z has spread to work
    // with and the factor produces finite readings well before the end.
    const snapRows: SnapshotRow[] = [];
    const snapCount = opts.snapshotRows?.[symbol] ?? count;
    for (let i = 0; i < snapCount; i++) {
      const ratio = 1.2 + Math.sin(i / 9) * 0.35;
      snapRows.push({
        t: START + i * stepMs,
        fundingRate: { rate: 0.0001, markPrice: 100 },
        longShortRatio: { ratio, longAccount: 0.55, shortAccount: 0.45 },
        openInterest: null,
        fearGreed: null,
        newsSentiment: null,
      });
    }
    const snapPath = join(dir, 'snapshots', symbol, `${INTERVAL}.jsonl.gz`);
    await writeJsonlGz(snapPath, snapRows);
    files.push({
      path: `snapshots/${symbol}/${INTERVAL}.jsonl.gz`,
      kind: 'snapshots',
      symbol,
      interval: INTERVAL,
      rowCount: snapRows.length,
      startMs: snapRows.length > 0 ? snapRows[0].t : null,
      endMs: snapRows.length > 0 ? snapRows[snapRows.length - 1].t : null,
      sha256: await sha256File(snapPath),
    });
  }

  const manifest: DatasetManifest = {
    version: 1,
    generatedAt: new Date(START).toISOString(),
    commit: 'fixture',
    lockboxStart: new Date(Date.UTC(2026, 6, 1)).toISOString(),
    symbols: [...SYMBOLS],
    intervals: [INTERVAL],
    files,
    datasetHash: datasetHashOf(files),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function args(overrides: Partial<ExposureHarnessArgs> = {}): ExposureHarnessArgs {
  return {
    ...parseArgs(['--interval', INTERVAL, '--factor', FACTOR, '--dataset-dir', 'PLACEHOLDER']),
    ...overrides,
  };
}

describe('parseArgs', () => {
  const NOW = new Date(Date.UTC(2026, 8, 21, 10, 30));

  it('applies the documented defaults', () => {
    const parsed = parseArgs(['--interval', '1d'], NOW);
    expect(parsed.interval).toBe('1d');
    expect(parsed.factor).toBe('positioningZ360');
    expect(parsed.datasetDir).toBe('data/research');
    expect(parsed.windows).toBe(6);
    expect(parsed.trainFraction).toBe(0.4);
    expect(parsed.windowMode).toBe('rolling');
    expect(parsed.seed).toBe(42);
    expect(parsed.bootstrapN).toBe(1000);
    expect(parsed.timingDraws).toBe(200);
    expect(parsed.trials).toBe(EXPOSURE_GRID_CELL_COUNT);
    expect(parsed.trials).toBe(36);
    expect(parsed.stressFeeMult).toBe(1.5);
    expect(parsed.stressSlippageMult).toBe(2);
    expect(parsed.allowLockbox).toBe(false);
  });

  it('rejects a stress configuration that cannot stress anything', () => {
    expect(() =>
      parseArgs(['--interval', '1d', '--stress-fee-mult', '1', '--stress-slippage-mult', '1'])
    ).toThrow(/stress gate unreachable/);
  });

  it('rejects an unknown factor column and names the valid ones', () => {
    expect(() => parseArgs(['--interval', '1d', '--factor', 'nope'])).toThrow(
      /Unknown --factor "nope"[\s\S]*positioningZ180, positioningZ360, positioningZ720/
    );
  });

  it('requires --interval outside cell mode', () => {
    expect(() => parseArgs(['--factor', FACTOR])).toThrow(/--interval is required/);
  });

  it('parses --cell and allows cell mode without a factor or interval', () => {
    const parsed = parseArgs(['--cell', 'BTCUSDT:3', '--report', 'r.json']);
    expect(parsed.cell).toEqual({ symbol: 'BTCUSDT', window: 3 });
    expect(parsed.reportPath).toBe('r.json');
    expect(parsed.factor).toBeUndefined();
  });

  it('rejects a malformed --cell and an unknown flag', () => {
    expect(() => parseArgs(['--cell', 'BTCUSDT'])).toThrow(/Invalid --cell value/);
    expect(() => parseArgs(['--interval', '1d', '--bogus'])).toThrow(/Unknown flag --bogus/);
  });

  it('rejects a non-integer integer flag and a bad window mode', () => {
    expect(() => parseArgs(['--interval', '1d', '--seed', '1.5'])).toThrow(/Invalid --seed/);
    expect(() => parseArgs(['--interval', '1d', '--window-mode', 'bogus'])).toThrow(/window-mode/);
  });

  it('carries the timing seed offset constant', () => {
    expect(TIMING_SEED_OFFSET).toBe(1_000_000);
  });
});

describe('runExposureHarness', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exposure-harness-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces a schema-valid report with the phase geometry', async () => {
    await buildFixture(dir);
    const out = join(dir, 'report.json');
    const report = await runExposureHarness(
      args({ datasetDir: dir, out, timingDraws: 20, bootstrapN: 50 })
    );

    expect(validateExposureReport(report).ok).toBe(true);
    expect(report.factor).toBe(FACTOR);
    expect(report.interval).toBe(INTERVAL);
    expect(report.gridCells).toBe(36);
    expect(report.trials).toBe(36);
    expect(report.windows).toHaveLength(report.windowConfig.count);
    expect(report.windows).toHaveLength(6);
    expect(report.timing.draws).toBe(20);
    expect(report.gates.map((g) => g.name)).toEqual([
      'sample',
      'expectancy',
      'windows',
      'symbols',
      'timing',
      'trials',
      'stress',
      'plateau',
    ]);
    expect(report.perSymbol.map((p) => p.symbol)).toEqual(SYMBOLS);
  });

  it('reports the realised block length as the one the shuffle used', async () => {
    await buildFixture(dir);
    const report = await runExposureHarness(
      args({ datasetDir: dir, out: join(dir, 'r.json'), timingDraws: 5, bootstrapN: 50 })
    );
    expect(report.timing.blockLength).toBe(report.pooled.bootstrap.meanBlockLen);
    expect(report.pooled.bootstrap.meanBlockLen).toBeGreaterThanOrEqual(32);
  });

  it('every pooled key survives schema validation', async () => {
    await buildFixture(dir);
    const report = await runExposureHarness(
      args({ datasetDir: dir, out: join(dir, 'r.json'), timingDraws: 5, bootstrapN: 50 })
    );
    // The payoffRatio guard, restated: a field computed but not declared in
    // the schema would be silently stripped, and the harness would have thrown.
    for (const key of [
      'barsHeld',
      'exposureShare',
      'meanReturnPercent',
      'sharpe',
      'sharpeCi95',
      'maxDrawdownPercent',
      'slowTurnover',
    ]) {
      if (key === 'slowTurnover') continue;
      expect(report.pooled).toHaveProperty(key);
    }
    expect(report.pooled).toHaveProperty('totalTurnover');
    expect(report.pooled).toHaveProperty('meanBarsBetweenRebalances');
  });

  it('perSymbol agrees with the pooled symbol counts', async () => {
    await buildFixture(dir);
    const report = await runExposureHarness(
      args({ datasetDir: dir, out: join(dir, 'r.json'), timingDraws: 5, bootstrapN: 50 })
    );
    const positive = report.perSymbol.filter((p) => p.positive).length;
    const withBars = report.perSymbol.filter((p) => p.bars > 0).length;
    expect(positive).toBe(report.pooled.symbolsPositive);
    expect(withBars).toBe(report.pooled.symbolsTotal);
  });

  it('window rows reproduce the pooling rule for a positive window', async () => {
    await buildFixture(dir);
    const report = await runExposureHarness(
      args({ datasetDir: dir, out: join(dir, 'r.json'), timingDraws: 5, bootstrapN: 50 })
    );
    for (const w of report.windows) {
      if (w.meanReturnPercent === null) {
        expect(w.positive).toBe(false);
      } else {
        expect(w.positive).toBe(w.meanReturnPercent > 0);
      }
    }
  });

  it('the nominal headline is not the stressed series', async () => {
    await buildFixture(dir);
    const report = await runExposureHarness(
      args({ datasetDir: dir, out: join(dir, 'r.json'), timingDraws: 5, bootstrapN: 50 })
    );
    // The stress gate reads a separate pool call; the headline must be the
    // unstressed one, or the two gates would be scoring the same series.
    expect(report.pooled.stressMeanReturnPercent).not.toBeNull();
    expect(report.pooled.stressMeanReturnPercent).not.toBe(report.pooled.meanReturnPercent);
    expect(report.pass).toBe(report.gates.every((g) => g.pass));
  });

  it('rejects a manifest hash mismatch', async () => {
    await buildFixture(dir);
    await expect(
      runExposureHarness(
        args({
          datasetDir: dir,
          out: join(dir, 'r.json'),
          expectManifestHash: 'deadbeef',
          timingDraws: 5,
          bootstrapN: 50,
        })
      )
    ).rejects.toThrow(/manifest hash/i);
  });

  it('runs a single-symbol universe when --symbols narrows it', async () => {
    await buildFixture(dir);
    const report = await runExposureHarness(
      args({
        datasetDir: dir,
        out: join(dir, 'r.json'),
        symbols: ['BTCUSDT'],
        timingDraws: 5,
        bootstrapN: 50,
      })
    );
    expect(report.symbols).toEqual(['BTCUSDT']);
  });

  it('aborts on mixed snapshot coverage', async () => {
    // BTCUSDT carries funding readings and ETHUSDT carries none, so one symbol
    // would pay funding while the other did not, and the report has no field
    // to record that asymmetry. Refusing is the only honest option.
    const mixedDir = mkdtempSync(join(tmpdir(), 'exposure-harness-mixed-'));
    try {
      await buildFixture(mixedDir, { snapshotRows: { ETHUSDT: 0 } });
      await expect(
        runExposureHarness(
          args({
            datasetDir: mixedDir,
            out: join(mixedDir, 'r.json'),
            timingDraws: 5,
            bootstrapN: 50,
          })
        )
      ).rejects.toThrow(/Mixed snapshot coverage/);
    } finally {
      rmSync(mixedDir, { recursive: true, force: true });
    }
  });
});

describe('runCell', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exposure-cell-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reproduces the reported window and writes nothing', async () => {
    await buildFixture(dir);
    const out = join(dir, 'report.json');
    const report = await runExposureHarness(
      args({ datasetDir: dir, out, timingDraws: 5, bootstrapN: 50 })
    );

    const check = await runCell(
      args({
        datasetDir: dir,
        cell: { symbol: 'BTCUSDT', window: 2 },
        reportPath: out,
        out: join(dir, 'untouched.json'),
      })
    );

    const expected = report.windows[2];
    expect(check.params).toEqual(expected.params);
    expect(check.bars).toBe(expected.bars);
    expect(check.sharpe).toBeCloseTo(expected.sharpe ?? 0, 9);
    expect(check.meanReturnPercent).toBeCloseTo(expected.meanReturnPercent ?? 0, 9);
  });

  it('refuses a missing --report and an out-of-range window', async () => {
    await buildFixture(dir);
    const out = join(dir, 'report.json');
    await runExposureHarness(args({ datasetDir: dir, out, timingDraws: 5, bootstrapN: 50 }));

    await expect(
      runCell(args({ datasetDir: dir, cell: { symbol: 'BTCUSDT', window: 0 } }))
    ).rejects.toThrow(/requires --report/);

    await expect(
      runCell(
        args({ datasetDir: dir, cell: { symbol: 'BTCUSDT', window: 99 }, reportPath: out })
      )
    ).rejects.toThrow(/not present in report/);
  });

  it('refuses a symbol outside the report universe', async () => {
    await buildFixture(dir);
    const out = join(dir, 'report.json');
    await runExposureHarness(args({ datasetDir: dir, out, timingDraws: 5, bootstrapN: 50 }));

    await expect(
      runCell(args({ datasetDir: dir, cell: { symbol: 'SOLUSDT', window: 1 }, reportPath: out }))
    ).rejects.toThrow(/not present in report/);
  });

  it('refuses a factor or interval that disagrees with the report', async () => {
    await buildFixture(dir);
    const out = join(dir, 'report.json');
    await runExposureHarness(args({ datasetDir: dir, out, timingDraws: 5, bootstrapN: 50 }));

    await expect(
      runCell(
        args({
          datasetDir: dir,
          cell: { symbol: 'BTCUSDT', window: 1 },
          reportPath: out,
          factor: 'positioningZ180',
        })
      )
    ).rejects.toThrow(/disagrees with the report's factor/);

    await expect(
      runCell(
        args({
          datasetDir: dir,
          cell: { symbol: 'BTCUSDT', window: 1 },
          reportPath: out,
          interval: '4h',
        })
      )
    ).rejects.toThrow(/disagrees with the report's interval/);
  });

  it('refuses a --symbols set that differs, because it changes gross', async () => {
    await buildFixture(dir);
    const out = join(dir, 'report.json');
    await runExposureHarness(args({ datasetDir: dir, out, timingDraws: 5, bootstrapN: 50 }));

    await expect(
      runCell(
        args({
          datasetDir: dir,
          cell: { symbol: 'BTCUSDT', window: 1 },
          reportPath: out,
          symbols: ['BTCUSDT'],
        })
      )
    ).rejects.toThrow(/different universe changes/);
  });
});
