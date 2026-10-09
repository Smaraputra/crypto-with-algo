import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SNIPE_DISCOVERY_CELLS } from './snipe';
import { FIXTURE_SYMBOLS, writeSyntheticCache } from './snipe-cache-fixture';
import { parseArgs, runSnipeScan, type SnipeDiscoveryReport } from './snipe-scan';

const DRAWS = 20;
const PLANT = { column: 'raw.ret1', share: 0.15 };
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'snipe-scan-'));
  dirs.push(d);
  return d;
};
const quiet = () => undefined;
const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

let plantedDir: string;
let nullDir: string;
let planted: SnipeDiscoveryReport;
let nullReport: SnipeDiscoveryReport;

function scan(dir: string, extra: Partial<Parameters<typeof runSnipeScan>[0]> = {}) {
  return runSnipeScan(
    { cacheDir: dir, timeframes: ['scalp', 'intraday'], draws: DRAWS, symbols: FIXTURE_SYMBOLS, ...extra },
    quiet
  );
}

beforeAll(() => {
  plantedDir = tmp();
  writeSyntheticCache({ dir: plantedDir, plant: PLANT });
  nullDir = tmp();
  writeSyntheticCache({ dir: nullDir });
  planted = scan(plantedDir) as SnipeDiscoveryReport;
  nullReport = scan(nullDir) as SnipeDiscoveryReport;
}, 600_000);

afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('snipe-scan', () => {
  it('produces 304 cells and the exact report keys', () => {
    expect(planted.cells).toHaveLength(SNIPE_DISCOVERY_CELLS);
    expect(Object.keys(planted).sort()).toEqual(
      [
        'reportKind',
        'schemaVersion',
        'datasetManifestHash',
        'gitCommit',
        'binding',
        'computedAt',
        'slice',
        'draws',
        'seed',
        'minShiftDays',
        'symbols',
        'timeframes',
        'fdrQ',
        'columns',
        'sanity',
        'cells',
        'selected',
        'verdict',
      ].sort()
    );
    expect(planted.reportKind).toBe('snipe-discovery');
    expect(planted.draws).toBe(DRAWS);
    expect(planted.seed).toBe(7);
    expect(planted.datasetManifestHash).toBe('hash-test');
    expect(planted.columns).toHaveLength(38);
    expect(planted.sanity.map((s) => s.timeframe)).toEqual(['scalp', 'intraday']);
    const s = planted.sanity[1];
    expect(s.inSliceBars).toBeGreaterThan(0);
    expect(s.strata).toBeGreaterThan(0);
    expect(s.gridLength).toBeGreaterThan(2 * s.minShiftBars);
    expect(Object.keys(s.barsLostToGrid)).toEqual(FIXTURE_SYMBOLS);
    expect(s.shares.up + s.shares.down + s.shares.timeout + s.shares.ambiguous).toBeCloseTo(1, 10);
    expect(s.pooledLongWinRate).toBeCloseTo(0.5, 1);
    expect(planted.cells[0]).toHaveProperty('bhRejected');
  });

  it('labels a subset run, a non-spec draw count and an unset commit as non-binding (A1-6)', () => {
    // fixture symbols are not the ten SIGNAL_SYMBOLS, the draw count is 20 and no GIT_COMMIT is set
    expect(planted.binding).toBe(false);
    expect(nullReport.binding).toBe(false);
    expect(planted.gitCommit).toBe(process.env.GIT_COMMIT ?? 'unknown');
  });

  it('selects a planted edge as a long edge', () => {
    expect(planted.verdict).toBe('SELECTED');
    const hit = planted.selected.find(
      (c) => c.cell.column === 'raw.ret1' && c.cell.tail === 'top' && c.cell.level === 'many' && c.cell.timeframe === 'intraday'
    );
    expect(hit).toBeDefined();
    expect(hit!.direction).toBe(1);
    expect(hit!.winRate).toBeGreaterThan(0.9);
  });

  it('closes NULL when there is no planted edge', () => {
    expect(nullReport.cells).toHaveLength(SNIPE_DISCOVERY_CELLS);
    expect(nullReport.selected).toHaveLength(0);
    expect(nullReport.verdict).toBe('NULL');
  });

  it('--cell reproduces the report entry exactly', () => {
    for (const idx of [5, 150, 160, 303]) {
      const entry = planted.cells[idx];
      const lines: string[] = [];
      runSnipeScan(
        { cacheDir: plantedDir, timeframes: [entry.cell.timeframe], draws: DRAWS, symbols: FIXTURE_SYMBOLS, cell: entry.cell },
        (l) => lines.push(l)
      );
      expect(lines).toHaveLength(1);
      const { bhRejected, ...rest } = roundTrip(entry);
      expect(bhRejected).toBeTypeOf('boolean');
      expect(JSON.parse(lines[0])).toEqual(rest);
    }
  });

  it('writes the report to --out and serialises non-finite numbers as null', () => {
    const dir = tmp();
    const out = join(dir, 'r.json');
    writeSyntheticCache({
      dir,
      symbols: FIXTURE_SYMBOLS,
      scalp: { startMs: Date.UTC(2024, 9, 1), bars: 20_160 },
      intraday: { startMs: Date.UTC(2024, 0, 1), bars: 100 * 24 },
    });
    scan(dir, { timeframes: ['scalp'], out });
    const text = readFileSync(out, 'utf8');
    expect(text).not.toMatch(/NaN|Infinity/);
    expect((JSON.parse(text) as SnipeDiscoveryReport).cells).toHaveLength(152);
  }, 120_000);

  it('throws on a dataset hash mismatch across files', () => {
    const dir = tmp();
    writeSyntheticCache({
      dir,
      symbols: ['AAAUSDT', 'BBBUSDT'],
      hashOverride: { BBBUSDT: 'other-hash' },
      scalp: { startMs: Date.UTC(2024, 9, 1), bars: 100 },
      intraday: { startMs: Date.UTC(2024, 9, 1), bars: 100 },
    });
    expect(() => scan(dir, { symbols: ['AAAUSDT', 'BBBUSDT'] })).toThrow(/hash mismatch/);
  });

  it('refuses data at or after the lockbox start', () => {
    const dir = tmp();
    writeSyntheticCache({
      dir,
      symbols: ['AAAUSDT'],
      scalp: { startMs: Date.UTC(2026, 5, 30, 12), bars: 400 },
      intraday: { startMs: Date.UTC(2026, 5, 30, 12), bars: 100 },
    });
    expect(() => scan(dir, { symbols: ['AAAUSDT'] })).toThrow(/lockbox/);
  });

  it('parses flags', () => {
    const a = parseArgs(['--cache-dir', 'c', '--out', 'o.json', '--timeframes', 'intraday', '--draws', '5']);
    expect(a).toMatchObject({ cacheDir: 'c', out: 'o.json', timeframes: ['intraday'], draws: 5 });
    expect(parseArgs(['--cache-dir', 'c', '--out', 'o']).draws).toBe(200);
    const c = parseArgs(['--cache-dir', 'c', '--cell', 'raw.ret1:top:many:scalp']);
    expect(c.cell).toEqual({ column: 'raw.ret1', tail: 'top', level: 'many', timeframe: 'scalp' });
    expect(c.timeframes).toEqual(['scalp']);
    expect(() => parseArgs(['--cache-dir', 'c'])).toThrow(/--out/);
    expect(() => parseArgs(['--cache-dir', 'c', '--out', 'o', '--bogus', '1'])).toThrow(/Unknown flag/);
    expect(() => parseArgs(['--cache-dir', 'c', '--cell', 'raw.nope:top:many:scalp'])).toThrow(/Unknown column/);
  });
});
