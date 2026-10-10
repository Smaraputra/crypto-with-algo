// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LOCKBOX_START,
  LOCKBOX_START_ISO,
  datasetHashOf,
  sha256File,
  writeJsonlGz,
  type CandleRow,
  type DatasetManifest,
  type HtfRow,
  type ManifestFile,
  type PerpCandleRow,
} from './dataset-format';
import {
  buildFactorIcReport,
  loadSymbolData,
  parseArgs as parseFactorIcArgs,
  pooledHorizonStat,
  symbolForwardReturns,
} from './factor-ic';
import {
  assertBeforeLockbox,
  buildNullReport,
  commonGrid,
  drawOffsets,
  minShiftBarsOf,
  parseNullArgs,
} from './qh-flow-null';

const HOUR = 3_600_000;
const START = Date.UTC(2025, 0, 1);
const COUNT = 600;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

function makeRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

function candles(seed: number, ar: number): CandleRow[] {
  const next = makeRng(seed);
  const rows: CandleRow[] = [];
  let price = 100;
  let prev = 0;
  for (let i = 0; i < COUNT; i++) {
    const ret = ar * prev + (next() - 0.5) * 0.02;
    prev = ret;
    const close = price * (1 + ret);
    rows.push({
      t: START + i * HOUR,
      o: price,
      h: Math.max(price, close) * 1.001,
      l: Math.min(price, close) * 0.999,
      c: close,
      v: 1000 + next() * 500,
      tbv: 500,
    });
    price = close;
  }
  return rows;
}

async function buildDataset(
  dir: string,
  ar: number,
  drop?: { symbol: string; index: number }
): Promise<DatasetManifest> {
  const files: ManifestFile[] = [];
  const add = async (kind: ManifestFile['kind'], symbol: string, rows: { t: number }[]) => {
    const rel = `${kind}/${symbol}/1h.jsonl.gz`;
    await writeJsonlGz(join(dir, rel), rows);
    files.push({
      path: rel,
      kind,
      symbol,
      interval: '1h',
      rowCount: rows.length,
      startMs: rows.length ? rows[0].t : null,
      endMs: rows.length ? rows[rows.length - 1].t : null,
      sha256: await sha256File(join(dir, rel)),
    });
  };
  for (const [i, symbol] of SYMBOLS.entries()) {
    let rows = candles(4242 + i * 1000, ar);
    if (drop && drop.symbol === symbol) rows = rows.filter((_, j) => j !== drop.index);
    await add('candles', symbol, rows);
    await add('snapshots', symbol, []);
    await add('htf', symbol, rows.map((c): HtfRow => ({ t: c.t, context: null })));
    await add(
      'perp',
      symbol,
      rows.map((c): PerpCandleRow => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c * 1.01, v: c.v, qv: c.v * c.c, n: 100, tbv: c.tbv }))
    );
  }
  const manifest: DatasetManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    commit: 'test-fixture',
    lockboxStart: LOCKBOX_START_ISO,
    symbols: SYMBOLS,
    intervals: ['1h'],
    files,
    datasetHash: datasetHashOf(files),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function argv(dir: string, extra: string[] = []): string[] {
  return [
    '--interval', '1h',
    '--dataset-dir', dir,
    '--horizons', '1,4',
    '--factors', 'raw.ret1',
    '--execution-lag', '1',
    '--return-series', 'perp',
    '--min-shift-days', '2',
    '--out', join(dir, 'out.json'),
    ...extra,
  ];
}

/** Writes a null-only floor report for the same argv and returns its path. */
async function makeFloor(dir: string, extra: string[] = [], name = 'floor.json'): Promise<string> {
  const report = await buildNullReport(parseNullArgs(argv(dir, extra)));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(report));
  return path;
}

describe('qh-flow-null', () => {
  let arDir: string;
  let noiseDir: string;

  beforeAll(async () => {
    arDir = mkdtempSync(join(tmpdir(), 'qh-null-ar-'));
    noiseDir = mkdtempSync(join(tmpdir(), 'qh-null-noise-'));
    await buildDataset(arDir, 0.8);
    await buildDataset(noiseDir, 0);
  });

  afterAll(() => {
    rmSync(arDir, { recursive: true, force: true });
    rmSync(noiseDir, { recursive: true, force: true });
  });

  describe('parseNullArgs', () => {
    it('applies the locked defaults: lag 1, perp, null-only, per-interval horizons', () => {
      const a = parseNullArgs(['--interval', '1h']);
      expect(a.draws).toBe(200);
      expect(a.seed).toBe(7);
      expect(a.minShiftDays).toBe(30);
      expect(a.nullOnly).toBe(true);
      expect(a.executionLagBars).toBe(1);
      expect(a.returnSeries).toBe('perp');
      expect(a.horizons).toEqual([1, 4, 8, 12]);
      expect(a.factors).toEqual(['raw.qhOpenImb', 'raw.fiveMinOpenImb', 'raw.largeTakerImb', 'raw.smallTakerImb']);
      expect(parseNullArgs(['--interval', '4h']).horizons).toEqual([1, 2, 3]);
    });

    it('errors on an interval with no locked horizons unless --horizons is given', () => {
      expect(() => parseNullArgs(['--interval', '15m'])).toThrow(/--horizons/);
      expect(parseNullArgs(['--interval', '15m', '--horizons', '1,2']).horizons).toEqual([1, 2]);
    });

    it('--with-observed needs a floor report, and a floor report needs --with-observed', () => {
      expect(() => parseNullArgs(['--interval', '1h', '--with-observed'])).toThrow(/--floor-report/);
      expect(() => parseNullArgs(['--interval', '1h', '--floor-report', 'x.json'])).toThrow(/--with-observed/);
      const a = parseNullArgs(['--interval', '1h', '--with-observed', '--floor-report', 'x.json']);
      expect(a.nullOnly).toBe(false);
      expect(a.floorReport).toBe('x.json');
      expect(() =>
        parseNullArgs(['--interval', '1h', '--null-only', '--with-observed', '--floor-report', 'x.json'])
      ).toThrow(/contradict/);
    });

    it('accepts seed 0 and rejects negative seeds', () => {
      expect(parseNullArgs(['--interval', '1h', '--seed', '0']).seed).toBe(0);
      expect(() => parseNullArgs(['--interval', '1h', '--seed', '-1'])).toThrow(/--seed/);
      expect(() => parseNullArgs(['--interval', '1h', '--draws', '0'])).toThrow(/--draws/);
    });

    it('rejects --allow-lockbox as an unknown flag', () => {
      expect(() => parseNullArgs(['--interval', '1h', '--allow-lockbox'])).toThrow(/Unknown flag/);
    });
  });

  describe('drawOffsets', () => {
    it('is deterministic for a seed and differs across seeds', () => {
      const a = drawOffsets(7, 50, 600, 48);
      expect(a).toEqual(drawOffsets(7, 50, 600, 48));
      expect(a).not.toEqual(drawOffsets(8, 50, 600, 48));
    });

    it('gives ONE integer offset per draw, within [minShift, G - minShift]', () => {
      const draws = drawOffsets(7, 400, 900, 48);
      expect(draws).toHaveLength(400);
      for (const k of draws) {
        expect(Number.isInteger(k)).toBe(true);
        expect(k).toBeGreaterThanOrEqual(48);
        expect(k).toBeLessThanOrEqual(900 - 48);
      }
      expect(new Set(draws).size).toBeGreaterThan(100);
    });

    it('throws when the grid is too short to shift', () => {
      expect(() => drawOffsets(7, 1, 90, 48)).toThrow(/too short/);
    });
  });

  describe('commonGrid', () => {
    it('intersects the symbols after warmup and counts what each loses', () => {
      const a = { symbol: 'A', timestamps: [0, 1, 2, 3, 4, 5], warmupBars: 1 };
      const b = { symbol: 'B', timestamps: [0, 1, 3, 4, 5, 6], warmupBars: 1 };
      const g = commonGrid([a, b]);
      // A after warmup: 1..5; B after warmup: 1,3,4,5,6. Intersection: 1,3,4,5.
      expect(g.timestamps).toEqual([1, 3, 4, 5]);
      expect(g.indices).toEqual([[1, 3, 4, 5], [1, 2, 3, 4]]);
      expect(g.grid.bars).toBe(4);
      expect(g.grid.perSymbol).toEqual([
        { symbol: 'A', barsAfterWarmup: 5, dropped: 1 },
        { symbol: 'B', barsAfterWarmup: 5, dropped: 1 },
      ]);
    });
  });

  describe('minShiftBarsOf', () => {
    it('is ceil(days * 86_400_000 / intervalMs)', () => {
      expect(minShiftBarsOf(30, '1h')).toBe(720);
      expect(minShiftBarsOf(30, '4h')).toBe(180);
      expect(minShiftBarsOf(2, '1h')).toBe(48);
    });
  });

  describe('assertBeforeLockbox', () => {
    it('refuses timestamps at or after the lockbox start', () => {
      expect(() => assertBeforeLockbox([LOCKBOX_START - HOUR])).not.toThrow();
      expect(() => assertBeforeLockbox([LOCKBOX_START])).toThrow(/lockbox/i);
    });
  });

  describe('buildNullReport', () => {
    it('is deterministic for a fixed seed', async () => {
      const args = parseNullArgs(argv(arDir, ['--draws', '20']));
      const a = await buildNullReport(args);
      const b = await buildNullReport(args);
      expect(a.cells).toEqual(b.cells);
      expect(a.offsets).toEqual(b.offsets);
    });

    it('observed ic and t equal factor-ic to full precision', async () => {
      const floor = await makeFloor(arDir, ['--draws', '5']);
      const args = parseNullArgs(argv(arDir, ['--draws', '5', '--with-observed', '--floor-report', floor]));
      const report = await buildNullReport(args);
      const ref = await buildFactorIcReport(
        parseFactorIcArgs([
          '--interval', '1h',
          '--dataset-dir', arDir,
          '--factors', 'raw.ret1',
          '--horizons', '1,4',
          '--execution-lag', '1',
          '--return-series', 'perp',
          '--bootstrap-n', '10',
        ])
      );
      const pooled = ref.factors.find((f) => f.name === 'raw.ret1')!.pooled.horizons;
      expect(report.cells).toHaveLength(2);
      for (const cell of report.cells) {
        const stat = pooled.find((h) => h.horizon === cell.horizon)!;
        expect(cell.observedIc).toBe(stat.ic);
        expect(cell.observedT).toBe(stat.icT);
      }
      expect(report.datasetManifestHash).toBe(ref.datasetManifestHash);
    });

    it('gives a strongly predictive column the minimum empirical p', async () => {
      const floor = await makeFloor(arDir, ['--draws', '200', '--horizons', '1']);
      const args = parseNullArgs(
        argv(arDir, ['--draws', '200', '--horizons', '1', '--with-observed', '--floor-report', floor])
      );
      const report = await buildNullReport(args);
      const cell = report.cells[0];
      expect(cell.validDraws).toBe(200);
      expect(cell.observedIc!).toBeGreaterThan(0.3);
      expect(cell.empiricalP).toBeCloseTo(1 / 201, 12);
      expect(Math.abs(cell.observedT!)).toBeGreaterThan(cell.nullP95AbsT);
      expect(cell.detectionFloorIc).toBeCloseTo(3.15 * cell.nullSdIc, 12);
    });

    it('gives a noise column an empirical p above 0.05', async () => {
      const floor = await makeFloor(noiseDir, ['--draws', '200', '--horizons', '1']);
      const args = parseNullArgs(
        argv(noiseDir, ['--draws', '200', '--horizons', '1', '--with-observed', '--floor-report', floor])
      );
      const report = await buildNullReport(args);
      const cell = report.cells[0];
      expect(cell.empiricalP!).toBeGreaterThan(0.05);
      // (1 + exceedances) / (1 + valid draws), an integer count over 1 + validDraws.
      const exceed = cell.empiricalP! * (1 + cell.validDraws) - 1;
      expect(Math.abs(exceed - Math.round(exceed))).toBeLessThan(1e-9);
      expect(exceed).toBeGreaterThanOrEqual(0);
    });

    it('is null-only by default and omits every observed field', async () => {
      const args = parseNullArgs(argv(arDir, ['--draws', '10']));
      const report = await buildNullReport(args);
      expect(report.args.nullOnly).toBe(true);
      expect(report.reportKind).toBe('qh-flow-null');
      for (const cell of report.cells) {
        expect(Object.keys(cell).sort()).toEqual(
          ['detectionFloorIc', 'factor', 'horizon', 'nullMeanIc', 'nullP95AbsT', 'nullSdIc', 'validDraws'].sort()
        );
      }
      expect(JSON.stringify(report)).not.toMatch(/observed|empiricalP/);
    });
  });

  describe('common grid and shared offset', () => {
    it('uses one offset per draw and reports the bars each symbol loses to the intersection', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qh-null-gap-'));
      try {
        await buildDataset(dir, 0.8, { symbol: 'ETHUSDT', index: 400 });
        const report = await buildNullReport(parseNullArgs(argv(dir, ['--draws', '10'])));
        expect(report.offsets).toHaveLength(10);
        expect(report.offsets.every((k) => Number.isInteger(k))).toBe(true);
        const drops = Object.fromEntries(report.grid.perSymbol.map((p) => [p.symbol, p.dropped]));
        expect(drops).toEqual({ BTCUSDT: 1, ETHUSDT: 0, SOLUSDT: 1 });
        expect(report.barCounts).toEqual([COUNT, COUNT - 1, COUNT]);
        expect(report.grid.bars).toBe(report.grid.perSymbol[1].barsAfterWarmup);
        for (const k of report.offsets) {
          expect(k).toBeGreaterThanOrEqual(report.minShiftBars);
          expect(k).toBeLessThanOrEqual(report.grid.bars - report.minShiftBars);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('floor report gate', () => {
    const withObs = (dir: string, floor: string, extra: string[] = []) =>
      parseNullArgs(argv(dir, ['--draws', '5', '--with-observed', '--floor-report', floor, ...extra]));

    it('accepts a matching null-only floor report', async () => {
      const floor = await makeFloor(arDir, ['--draws', '5']);
      const report = await buildNullReport(withObs(arDir, floor));
      expect(report.floorReport?.path).toBe(floor);
      expect(report.cells[0].observedIc).not.toBeUndefined();
    });

    it('refuses a missing file, a foreign file, a with-observed report and any mismatch', async () => {
      await expect(buildNullReport(withObs(arDir, join(arDir, 'nope.json')))).rejects.toThrow(/cannot be read/);

      const foreign = join(arDir, 'foreign.json');
      writeFileSync(foreign, JSON.stringify({ args: { nullOnly: true } }));
      await expect(buildNullReport(withObs(arDir, foreign))).rejects.toThrow(/not a qh-flow-null report/);

      const floor = await makeFloor(arDir, ['--draws', '5']);
      const observed = join(arDir, 'observed.json');
      writeFileSync(observed, JSON.stringify(await buildNullReport(withObs(arDir, floor))));
      await expect(buildNullReport(withObs(arDir, observed))).rejects.toThrow(/not a null-only/);

      // Horizons, lag, return series, window, seed, draws and factors.
      await expect(buildNullReport(withObs(arDir, floor, ['--horizons', '1']))).rejects.toThrow(/horizons differ/);
      await expect(buildNullReport(withObs(arDir, floor, ['--execution-lag', '0']))).rejects.toThrow(/lag/);
      await expect(buildNullReport(withObs(arDir, floor, ['--return-series', 'spot']))).rejects.toThrow(/return series/);
      await expect(buildNullReport(withObs(arDir, floor, ['--start', '2025-01-05T00:00:00Z']))).rejects.toThrow(/window/);
      await expect(buildNullReport(withObs(arDir, floor, ['--seed', '8']))).rejects.toThrow(/seed/);
      await expect(buildNullReport(withObs(arDir, floor, ['--factors', 'raw.rsi']))).rejects.toThrow(/factors differ/);
    });

    it('refuses a floor report from a different dataset', async () => {
      const floor = await makeFloor(arDir, ['--draws', '5']);
      await expect(buildNullReport(withObs(noiseDir, floor))).rejects.toThrow(/manifest hash/);
    });
  });

  describe('shared pooled code path', () => {
    for (const lag of [0, 1]) {
      for (const returnSeries of ['spot', 'perp'] as const) {
        it(`factor-ic pooled block equals pooledHorizonStat at lag ${lag}, ${returnSeries}`, async () => {
          const factors = ['raw.ret1', 'raw.rsi'];
          const horizons = [1, 4, 8];
          const report = await buildFactorIcReport(
            parseFactorIcArgs([
              '--interval', '1h',
              '--dataset-dir', arDir,
              '--factors', factors.join(','),
              '--horizons', horizons.join(','),
              '--execution-lag', String(lag),
              '--return-series', returnSeries,
              '--bootstrap-n', '50',
            ])
          );
          const data = SYMBOLS.map((s) =>
            loadSymbolData(arDir, s, '1h', { allowLockbox: false })
          );
          for (const name of factors) {
            const cols = data.map((d) => d.matrix.values[d.matrix.names.indexOf(name)]);
            const expected = report.factors.find((f) => f.name === name)!.pooled.horizons;
            expect(expected.length).toBe(horizons.length);
            for (const h of horizons) {
              const fwd = data.map((d) => symbolForwardReturns(d, h, lag, returnSeries));
              const stat = pooledHorizonStat(cols, fwd, h, { iterations: 50, seed: 42, maxPairs: 100_000, gateAbsT: 2 });
              expect(stat).toEqual(expected.find((e) => e.horizon === h));
            }
          }
        });
      }
    }

    it('marks a cell factor-ic drops (all-NaN column) with NaN stats and a reason', async () => {
      const floor = await makeFloor(arDir, ['--draws', '5', '--factors', 'raw.qhOpenImb', '--horizons', '1']);
      const args = parseNullArgs(
        argv(arDir, ['--draws', '5', '--factors', 'raw.qhOpenImb', '--horizons', '1', '--with-observed', '--floor-report', floor])
      );
      const report = await buildNullReport(args);
      expect(report.cells).toHaveLength(1);
      const cell = report.cells[0];
      expect(cell.nullSdIc).toBeNaN();
      expect(cell.observedIc).toBeNull();
      expect(cell.observedT).toBeNull();
      expect(cell.empiricalP).toBeNull();
      expect(cell.reason).toMatch(/draws/);
      expect(cell.reason).toMatch(/observed/);
    });
  });
});
