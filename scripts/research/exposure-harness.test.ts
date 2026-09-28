// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  type HtfRow,
  type ManifestFile,
  type PerpCandleRow,
  type SnapshotRow,
} from './dataset-format';
import { validateExposureReport } from './report-schema';
import {
  EXPOSURE_GRID_CELL_COUNT,
  RANK_GRID_CELL_COUNT,
  RANK_PREREGISTERED_TRIALS,
} from './exposure-walk-forward';
import { computeFactorMatrix } from './factors';
import {
  TIMING_SEED_OFFSET,
  __testing,
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
  /** Overrides the module-level two-symbol universe. The rank grid's
   * `topBottom legs=2` cell needs at least 4 finite readings, which the
   * default two-symbol fixture cannot supply. */
  symbols?: string[];
  /** Symbols whose perp file gets one extra bar, inside the pre-lockbox
   * range, that the spot file never carries -- the real defect this fixture
   * reproduces: ADAUSDT's perp file at 1h has a bar the spot file does not. */
  perpExtraBarSymbols?: string[];
}

/**
 * Writes a minimal dataset: spot candles, perp klines on the SAME grid, and
 * snapshots carrying a long/short ratio so the positioning column can form.
 */
async function buildFixture(dir: string, opts: FixtureOptions = {}): Promise<void> {
  const count = opts.count ?? 1400;
  const symbols = opts.symbols ?? SYMBOLS;
  const stepMs = intervalToMs(INTERVAL);
  const files: ManifestFile[] = [];

  for (let s = 0; s < symbols.length; s++) {
    const symbol = symbols[s];
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
      if (opts.perpExtraBarSymbols?.includes(symbol)) {
        // Inserted well inside the pre-lockbox window (index 50, comfortably
        // before lockboxStart 2026-07-01), at a timestamp exactly between two
        // real bars: the fixture's default `--allow-lockbox`-off range trims
        // everything from ~day 912 on, so a bar appended past the series end
        // (like ADAUSDT's real extra 1h bar chronologically is not, but a
        // synthetic one placed past this fixture's end would be) never
        // survives the lockbox filter to reach the spot-grid check at all.
        const anchor = closes[50];
        perpRows.splice(51, 0, {
          t: START + 50 * stepMs + Math.floor(stepMs / 2),
          o: anchor * 1.0005,
          h: anchor * 1.006,
          l: anchor * 0.994,
          c: anchor * 1.001,
          v: 1200,
          qv: 120000,
          n: 500,
          tbv: null,
        });
      }
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
    symbols: [...symbols],
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
    expect(parsed.feeProfile).toBe('standard');
    expect(parsed.allowLockbox).toBe(false);
  });

  it('defaults --fee-profile to standard and validates the name', () => {
    expect(parseArgs(['--interval', '1d']).feeProfile).toBe('standard');
    expect(parseArgs(['--interval', '1d', '--fee-profile', 'promo-btc-eth-2026-07']).feeProfile).toBe(
      'promo-btc-eth-2026-07'
    );
    expect(() => parseArgs(['--interval', '1d', '--fee-profile', 'vip9'])).toThrow(/Unknown --fee-profile/);
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

  it('defaults mode, min-cross-section and fill; leaves factorSign unset', () => {
    const parsed = parseArgs(['--interval', '1d']);
    expect(parsed.mode).toBe('exposure');
    expect(parsed.minCrossSection).toBe(5);
    expect(parsed.fill).toBe('taker');
    expect(parsed.factorSign).toBeUndefined();
    expect(parsed.excludeSymbols).toBeUndefined();
  });

  it('parses rank-mode flags and requires --factor-sign in rank mode', () => {
    const a = parseArgs(['--mode', 'rank', '--interval', '1h', '--factor', 'realizedVol20', '--factor-sign', '-1']);
    expect(a.mode).toBe('rank');
    expect(a.factorSign).toBe(-1);
    expect(a.selectMetric).toBe('meanReturn');
    expect(a.fill).toBe('taker');
    expect(a.minCrossSection).toBe(5);

    expect(() =>
      parseArgs(['--mode', 'rank', '--interval', '1h', '--factor', 'realizedVol20'])
    ).toThrow(/--factor-sign/);
    // rank factors need rank mode
    expect(() => parseArgs(['--interval', '1h', '--factor', 'realizedVol20'])).toThrow(/rank mode/);
    expect(parseArgs(['--interval', '4h', '--factor', 'positioningZ360']).selectMetric).toBe('sharpe');
  });

  it('rejects an unknown --mode, --factor-sign, --select-metric and --fill', () => {
    expect(() => parseArgs(['--interval', '1d', '--mode', 'bogus'])).toThrow(/Invalid --mode/);
    expect(() =>
      parseArgs(['--interval', '1d', '--mode', 'rank', '--factor-sign', '2'])
    ).toThrow(/Invalid --factor-sign/);
    expect(() => parseArgs(['--interval', '1d', '--select-metric', 'bogus'])).toThrow(
      /Invalid --select-metric/
    );
    expect(() => parseArgs(['--interval', '1d', '--fill', 'bogus'])).toThrow(/Invalid --fill/);
  });

  it('rejects a rank-mode --min-cross-section below twice the widest rank scheme', () => {
    expect(() =>
      parseArgs([
        '--mode',
        'rank',
        '--interval',
        '1h',
        '--factor',
        'realizedVol20',
        '--factor-sign',
        '1',
        '--min-cross-section',
        '3',
      ])
    ).toThrow(/--min-cross-section must be at least 4 for the rank grid/);

    const parsed = parseArgs([
      '--mode',
      'rank',
      '--interval',
      '1h',
      '--factor',
      'realizedVol20',
      '--factor-sign',
      '1',
      '--min-cross-section',
      '5',
    ]);
    expect(parsed.minCrossSection).toBe(5);
  });

  it('parses --exclude-symbols into a list', () => {
    const parsed = parseArgs(['--interval', '1d', '--exclude-symbols', 'BTCUSDT, ETHUSDT']);
    expect(parsed.excludeSymbols).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('defaults --trials to the pre-registered 54 in rank mode', () => {
    const parsed = parseArgs([
      '--mode',
      'rank',
      '--interval',
      '1h',
      '--factor',
      'realizedVol20',
      '--factor-sign',
      '1',
    ]);
    expect(parsed.trials).toBe(RANK_PREREGISTERED_TRIALS);
    expect(RANK_PREREGISTERED_TRIALS).toBe(54);
    expect(RANK_GRID_CELL_COUNT).toBe(9);
  });

  it('keeps the exposure-mode --trials default unchanged in rank mode', () => {
    const parsed = parseArgs(['--interval', '1d']);
    expect(parsed.trials).toBe(EXPOSURE_GRID_CELL_COUNT);
    expect(parsed.trials).toBe(36);
  });
});

describe('realizedVol20Column', () => {
  it('equals the factors.ts estimator shifted one bar', () => {
    // computeFactorMatrix's underlying indicator suite needs >= 210 candles
    // at 1h (day_trading); the pin only cares about a stretch past bar 20,
    // so any sufficiently long series works.
    const count = 260;
    const timestamps: number[] = [];
    let price = 100;
    let rng = 7331;
    const next = (): number => {
      rng = (rng * 16807) % 2147483647;
      return rng / 2147483647;
    };
    const candleRows: CandleRow[] = [];
    for (let i = 0; i < count; i++) {
      const drift = Math.sin(i / 11) * 0.01;
      const noise = (next() - 0.5) * 2;
      price = price * (1 + drift + noise / 100);
      const t = Date.UTC(2024, 0, 1) + i * intervalToMs('1h');
      timestamps.push(t);
      candleRows.push({ t, o: price, h: price * 1.002, l: price * 0.998, c: price, v: 1000, tbv: null });
    }
    const htfRows: HtfRow[] = timestamps.map((t) => ({ t, context: null }));

    const matrix = computeFactorMatrix({
      candles: candleRows,
      snapshots: null,
      htf: htfRows,
      interval: '1h',
    });
    const idx = matrix.names.indexOf('raw.realizedVol20');
    expect(idx).toBeGreaterThanOrEqual(0);

    const column = __testing.realizedVol20Column(matrix.closes);

    expect(Number.isNaN(column[0])).toBe(true);
    // `computeFactorMatrix` NaNs every raw factor, including realizedVol20,
    // before the shared indicator warmup regardless of whether the 20-bar
    // formula itself has enough history -- see this file's header. The
    // loader's column has no such shared warmup, only the formula's own
    // 20-bar floor, so the two can only be pinned from `warmupBars` on.
    expect(matrix.warmupBars).toBeGreaterThan(20);
    let comparedFinite = 0;
    for (let i = matrix.warmupBars + 1; i < matrix.closes.length; i++) {
      const expected = matrix.values[idx][i - 1];
      if (Number.isNaN(expected)) {
        expect(Number.isNaN(column[i])).toBe(true);
      } else {
        expect(column[i]).toBeCloseTo(expected, 12);
        comparedFinite++;
      }
    }
    // Sanity: the loop above actually pinned some finite readings, so it is
    // not vacuously true.
    expect(comparedFinite).toBeGreaterThan(0);
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
    expect(report.feeProfile).toBe('standard');
  });

  it('threads --fee-profile through to the report and its costs', async () => {
    await buildFixture(dir);
    const out = join(dir, 'report.json');
    const report = await runExposureHarness(
      args({ datasetDir: dir, out, timingDraws: 5, bootstrapN: 50, feeProfile: 'bnb' })
    );

    expect(report.feeProfile).toBe('bnb');
    expect(report.costs.feePercent).toBeCloseTo(0.00045, 10);
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

  it('reproduces a report generated under a non-default --fee-profile, reading it from the report', async () => {
    await buildFixture(dir);
    const out = join(dir, 'report.json');
    const report = await runExposureHarness(
      args({ datasetDir: dir, out, timingDraws: 5, bootstrapN: 50, feeProfile: 'bnb' })
    );

    // No --fee-profile override here: args() defaults to 'standard', so this
    // only reproduces if runCell reads report.feeProfile, not the CLI's own
    // default.
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

describe('rank mode', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exposure-rank-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a rank report spot-checks at CLI defaults: mode, scheme params, sign, fill and exclusions come from the report', async () => {
    // Four symbols: the rank grid's `topBottom legs=2` cell needs 2*legs=4
    // finite readings, which the module-level two-symbol fixture cannot
    // supply (crossSectionalTargets throws below that).
    const rankSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'];
    await buildFixture(dir, { symbols: rankSymbols });
    const out = join(dir, 'report.json');
    const rankArgs = parseArgs([
      '--mode',
      'rank',
      '--interval',
      INTERVAL,
      '--factor',
      'realizedVol20',
      '--factor-sign',
      '-1',
      '--min-cross-section',
      '4',
      '--dataset-dir',
      dir,
      '--out',
      out,
      '--timing-draws',
      '5',
      '--bootstrap-n',
      '50',
    ]);
    const report = await runExposureHarness(rankArgs);

    expect(report.mode).toBe('rank');
    expect(report.factorSign).toBe(-1);
    expect(report.selectMetric).toBe('meanReturn');
    expect(report.fill).toBe('taker');
    expect(report.gridCells).toBe(RANK_GRID_CELL_COUNT);
    expect(report.gridCells).toBe(9);
    expect(validateExposureReport(report).ok).toBe(true);

    // A true --cell CLI invocation, so `factor`, `interval`, `mode`,
    // `factorSign`, `minCrossSection`, `selectMetric` and `fill` are all
    // undefined on the parsed args (parseArgs nils them out in cell mode) --
    // this is "args lacking every rank flag", and every one of them must be
    // read from the report for the window to reproduce.
    const cellArgs = parseArgs(['--cell', 'BTCUSDT:1', '--report', out, '--dataset-dir', dir]);
    expect(cellArgs.mode).toBeUndefined();
    expect(cellArgs.factorSign).toBeUndefined();
    expect(cellArgs.fill).toBeUndefined();

    const check = await runCell(cellArgs);

    const expected = report.windows[1];
    expect(check.params).toEqual(expected.params);
    expect(check.bars).toBe(expected.bars);
    expect(check.sharpe).toBeCloseTo(expected.sharpe ?? 0, 9);
    expect(check.meanReturnPercent).toBeCloseTo(expected.meanReturnPercent ?? 0, 9);
  });

  it('allows --mode rank with a non-rank-only factor, given --factor-sign', () => {
    // positioningZ360 is not rank-only, so --mode rank with it is not
    // rejected by the rank-only-factor check (only the missing --factor-sign
    // check would reject it, and that is exercised elsewhere).
    expect(() =>
      parseArgs(['--mode', 'rank', '--interval', '1d', '--factor', 'positioningZ360', '--factor-sign', '1'])
    ).not.toThrow();
  });
});

describe('--exclude-symbols', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exposure-exclude-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes the symbol from the universe and records it', async () => {
    await buildFixture(dir);
    const out = join(dir, 'report.json');
    const report = await runExposureHarness(
      args({
        datasetDir: dir,
        out,
        timingDraws: 5,
        bootstrapN: 50,
        excludeSymbols: ['BTCUSDT'],
      })
    );
    expect(report.symbols).toEqual(['ETHUSDT']);
    expect(report.excludedSymbols).toEqual(['BTCUSDT']);
  });

  it('omits excludedSymbols from the report when nothing was excluded', async () => {
    await buildFixture(dir);
    const out = join(dir, 'report.json');
    const report = await runExposureHarness(args({ datasetDir: dir, out, timingDraws: 5, bootstrapN: 50 }));
    expect(report.excludedSymbols).toBeUndefined();
  });

  it('refuses when every loaded symbol is excluded', async () => {
    await buildFixture(dir);
    const out = join(dir, 'report.json');
    await expect(
      runExposureHarness(
        args({
          datasetDir: dir,
          out,
          timingDraws: 5,
          bootstrapN: 50,
          excludeSymbols: ['BTCUSDT', 'ETHUSDT'],
        })
      )
    ).rejects.toThrow(/removed every symbol/);
  });
});

describe('perp/spot grid intersection', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exposure-gridfix-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops a perp bar absent from the spot grid, logs it and records the count per symbol', async () => {
    await buildFixture(dir, { perpExtraBarSymbols: ['ETHUSDT'] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = join(dir, 'report.json');
      const report = await runExposureHarness(args({ datasetDir: dir, out, timingDraws: 5, bootstrapN: 50 }));

      expect(validateExposureReport(report).ok).toBe(true);

      const eth = report.perSymbol.find((p) => p.symbol === 'ETHUSDT');
      const btc = report.perSymbol.find((p) => p.symbol === 'BTCUSDT');
      expect(eth?.perpBarsOffSpotGrid).toBe(1);
      expect(btc?.perpBarsOffSpotGrid ?? 0).toBe(0);

      const logged = errorSpy.mock.calls.some((call) =>
        String(call[0]).includes('ETHUSDT 1d: dropped 1 perp bars absent from the spot grid')
      );
      expect(logged).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reports no drop when the perp and spot grids agree, and the report is otherwise unchanged', async () => {
    await buildFixture(dir);
    const out = join(dir, 'report.json');
    const report = await runExposureHarness(args({ datasetDir: dir, out, timingDraws: 5, bootstrapN: 50 }));

    expect(validateExposureReport(report).ok).toBe(true);
    for (const p of report.perSymbol) {
      expect(p.perpBarsOffSpotGrid).toBeUndefined();
    }
    // Same shape and gates the pre-fix test already pinned: the filter is a
    // no-op when the two grids' timestamp sets are equal.
    expect(report.gridCells).toBe(36);
    expect(report.perSymbol.map((p) => p.symbol)).toEqual(SYMBOLS);
  });
});
