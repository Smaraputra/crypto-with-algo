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

async function buildDataset(dir: string, ar: number): Promise<DatasetManifest> {
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
    const rows = candles(4242 + i * 1000, ar);
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
    it('applies the locked defaults', () => {
      const a = parseNullArgs(['--interval', '1h']);
      expect(a.draws).toBe(200);
      expect(a.seed).toBe(7);
      expect(a.minShiftDays).toBe(30);
      expect(a.nullOnly).toBe(false);
      expect(a.executionLagBars).toBe(0);
      expect(a.returnSeries).toBe('spot');
      expect(a.factors).toEqual(['raw.qhOpenImb', 'raw.fiveMinOpenImb', 'raw.largeTakerImb', 'raw.smallTakerImb']);
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
      const a = drawOffsets(7, 50, [600, 600, 600], 48);
      const b = drawOffsets(7, 50, [600, 600, 600], 48);
      const c = drawOffsets(8, 50, [600, 600, 600], 48);
      expect(a).toEqual(b);
      expect(a).not.toEqual(c);
    });

    it('keeps every offset in [minShift, n - minShift] and varies per symbol', () => {
      const lengths = [600, 900, 1200];
      const draws = drawOffsets(7, 400, lengths, 48);
      expect(draws).toHaveLength(400);
      for (const row of draws) {
        row.forEach((k, s) => {
          expect(Number.isInteger(k)).toBe(true);
          expect(k).toBeGreaterThanOrEqual(48);
          expect(k).toBeLessThanOrEqual(lengths[s] - 48);
        });
      }
      // Independence: the same-length symbols do not move in lockstep.
      const same = drawOffsets(7, 400, [600, 600], 48);
      const equal = same.filter((r) => r[0] === r[1]).length;
      expect(equal).toBeLessThan(20);
      const x = same.map((r) => r[0]);
      const y = same.map((r) => r[1]);
      const mx = x.reduce((a, v) => a + v, 0) / x.length;
      const my = y.reduce((a, v) => a + v, 0) / y.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < x.length; i++) {
        sxy += (x[i] - mx) * (y[i] - my);
        sxx += (x[i] - mx) ** 2;
        syy += (y[i] - my) ** 2;
      }
      expect(Math.abs(sxy / Math.sqrt(sxx * syy))).toBeLessThan(0.15);
    });

    it('throws when a symbol is too short to shift', () => {
      expect(() => drawOffsets(7, 1, [90], 48)).toThrow(/too short/);
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
      const args = parseNullArgs(argv(arDir, ['--draws', '5']));
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
      const args = parseNullArgs(argv(arDir, ['--draws', '200', '--horizons', '1']));
      const report = await buildNullReport(args);
      const cell = report.cells[0];
      expect(cell.observedIc!).toBeGreaterThan(0.3);
      expect(cell.empiricalP).toBeCloseTo(1 / 201, 12);
      expect(Math.abs(cell.observedT!)).toBeGreaterThan(cell.nullP95AbsT);
      expect(cell.detectionFloorIc).toBeCloseTo(3.15 * cell.nullSdIc, 12);
    });

    it('gives a noise column an empirical p above 0.05', async () => {
      const args = parseNullArgs(argv(noiseDir, ['--draws', '200', '--horizons', '1']));
      const report = await buildNullReport(args);
      expect(report.cells[0].empiricalP!).toBeGreaterThan(0.05);
    });

    it('omits every observed field with --null-only', async () => {
      const args = parseNullArgs(argv(arDir, ['--draws', '10', '--null-only']));
      const report = await buildNullReport(args);
      expect(report.args.nullOnly).toBe(true);
      for (const cell of report.cells) {
        expect(Object.keys(cell).sort()).toEqual(
          ['detectionFloorIc', 'factor', 'horizon', 'nullMeanIc', 'nullP95AbsT', 'nullSdIc'].sort()
        );
      }
      expect(JSON.stringify(report)).not.toMatch(/observed|empiricalP/);
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
      const args = parseNullArgs(argv(arDir, ['--draws', '5', '--factors', 'raw.qhOpenImb', '--horizons', '1']));
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
