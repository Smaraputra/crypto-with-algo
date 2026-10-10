import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SNIPE_BARRIER_ATR, SNIPE_COLUMNS, SNIPE_DISCOVERY } from './snipe';
import { discoverySlice } from './snipe-cli';
import { FIXTURE_SYMBOLS, writeSyntheticCache } from './snipe-cache-fixture';
import { OUTCOME_AMBIGUOUS, OUTCOME_DOWN, OUTCOME_TIMEOUT, OUTCOME_UP } from './snipe-labels';
import { parseArgs, runSnipeSanity, sanityOnlyBlockOf, type SnipeSanityReport } from './snipe-scan';
import * as stats from './snipe-stats';

// Every statistic that could touch a cell is wrapped, so the test can prove none of them runs.
vi.mock('./snipe-stats', async (importOriginal) => {
  const m = await importOriginal<typeof import('./snipe-stats')>();
  return {
    ...m,
    evaluateCell: vi.fn(m.evaluateCell),
    confirmCell: vi.fn(m.confirmCell),
    nullOffsets: vi.fn(m.nullOffsets),
    nullDraws: vi.fn(m.nullDraws),
    shiftedExcess: vi.fn(m.shiftedExcess),
    summarizeNull: vi.fn(m.summarizeNull),
    takenTrades: vi.fn(m.takenTrades),
    bootstrapCi: vi.fn(m.bootstrapCi),
    benjaminiHochberg: vi.fn(m.benjaminiHochberg),
    selectForConfirmation: vi.fn(m.selectForConfirmation),
  };
});

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'snipe-sanity-'));
  dirs.push(d);
  return d;
};
const quiet = () => undefined;

let dir: string;
let report: SnipeSanityReport;
let printed: string[];
let out: string;

beforeAll(() => {
  dir = tmp();
  out = join(dir, 'sanity.json');
  writeSyntheticCache({
    dir,
    scalp: { startMs: Date.UTC(2024, 9, 1), bars: 20_160 },
    intraday: { startMs: Date.UTC(2023, 9, 1), bars: 820 * 24 },
  });
  printed = [];
  report = runSnipeSanity(
    { cacheDir: dir, timeframes: ['scalp', 'intraday'], draws: 0, symbols: FIXTURE_SYMBOLS, sanityOnly: true, out },
    (l) => printed.push(l)
  );
}, 120_000);

afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('snipe sanity-only mode (A1-5)', () => {
  it('computes no cell, no null and no statistic', () => {
    for (const name of [
      'evaluateCell',
      'confirmCell',
      'nullOffsets',
      'nullDraws',
      'shiftedExcess',
      'summarizeNull',
      'takenTrades',
      'bootstrapCi',
      'benjaminiHochberg',
      'selectForConfirmation',
    ] as const) {
      expect(vi.mocked(stats[name] as (...a: never[]) => unknown), name).not.toHaveBeenCalled();
    }
    // the written and the printed report carry no cell statistic either
    const text = readFileSync(out, 'utf8');
    for (const key of ['pTwoSided', 'empiricalP', 'obsAll', 'obsGrid', 'zP1', 'nullMean', 'bhRejected', 'selected', 'verdict']) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(printed.join('\n')).toBe(JSON.stringify(report, null, 2));
  });

  it('writes the report with the discovery slice, the binding flag and one block per timeframe', () => {
    expect(report.reportKind).toBe('snipe-sanity');
    expect(report.slice).toEqual({ start: SNIPE_DISCOVERY.start, end: SNIPE_DISCOVERY.end });
    expect(report.binding).toBe(false); // fixture symbols, no commit
    expect(report.gitCommit).toBe(process.env.GIT_COMMIT ?? 'unknown');
    expect(report.blocks.map((b) => b.timeframe)).toEqual(['scalp', 'intraday']);
    expect(JSON.parse(readFileSync(out, 'utf8')).reportKind).toBe('snipe-sanity');
    for (const b of report.blocks) {
      expect(b.inSliceBars).toBeGreaterThan(0);
      expect(b.shares.up + b.shares.down + b.shares.timeout + b.shares.ambiguous).toBeCloseTo(1, 10);
      expect(b.pooledLongWinRate).toBeCloseTo(0.5, 1);
      expect(b.strata).toBeGreaterThan(0);
      expect(b.gapLabels).toBe(0);
      expect(Object.keys(b.barsLostToGrid)).toEqual(FIXTURE_SYMBOLS);
      expect(b.columns.map((c) => c.column)).toEqual([...SNIPE_COLUMNS]);
      for (const c of b.columns) {
        expect(c.tailEligibleShare).toBe(1);
        expect(c.finiteShare).toBe(1);
        expect(c.finiteShareBySymbol).toHaveLength(FIXTURE_SYMBOLS.length);
      }
    }
  });

  it('draws a deterministic sample of 20 in-slice labels per timeframe and checks each against its row', () => {
    const again = runSnipeSanity(
      { cacheDir: dir, timeframes: ['scalp', 'intraday'], draws: 0, symbols: FIXTURE_SYMBOLS, sanityOnly: true },
      quiet
    );
    const slice = discoverySlice();
    for (const [k, b] of report.blocks.entries()) {
      expect(b.sample).toHaveLength(20);
      expect(again.blocks[k].sample).toEqual(b.sample);
      expect(new Set(b.sample.map((s) => `${s.symbol}|${s.conditionTime}`)).size).toBe(20);
      const interval = b.timeframe === 'scalp' ? 300_000 : 3_600_000;
      for (const s of b.sample) {
        expect(FIXTURE_SYMBOLS).toContain(s.symbol);
        const t = Date.parse(s.conditionTime);
        expect(t).toBeGreaterThanOrEqual(slice.startMs);
        expect(t).toBeLessThanOrEqual(slice.endMs);
        expect(Date.parse(s.entryTime)).toBe(t + interval);
        expect(Date.parse(s.exitTime)).toBe(t + 2 * interval);
        expect(s.upper).toBeCloseTo(s.entryPrice + SNIPE_BARRIER_ATR * s.atrAbs, 12);
        expect(s.lower).toBeCloseTo(s.entryPrice - SNIPE_BARRIER_ATR * s.atrAbs, 12);
        expect(['UP', 'DOWN', 'TIMEOUT', 'AMBIGUOUS']).toContain(s.outcome);
      }
    }
  });

  it('counts labels with a gap, tail-eligible shares and the sample from hand-built arrays', () => {
    const arrays = FIXTURE_SYMBOLS.slice(0, 2).map((symbol, k) => {
      const n = 30;
      const day = 86_400_000;
      const start = Date.UTC(2022, 5, 1);
      const timestamps = Float64Array.from({ length: n }, (_, i) => start + i * day);
      const outcomes = [OUTCOME_UP, OUTCOME_DOWN, OUTCOME_TIMEOUT, OUTCOME_AMBIGUOUS];
      return {
        symbol,
        timeframe: 'intraday' as const,
        columns: [...SNIPE_COLUMNS],
        timestamps,
        flags: SNIPE_COLUMNS.map((_, c) => new Uint8Array(n).fill(c === 0 ? 16 : 0)),
        outcome: Int8Array.from({ length: n }, (_, i) => outcomes[(i + k) % 4]),
        entryMs: Float64Array.from(timestamps, (t) => t + day),
        exitMs: Float64Array.from(timestamps, (t) => t + 2 * day),
        atrPct: new Float64Array(n).fill(1),
        entryPrice: Float64Array.from({ length: n }, (_, i) => 100 + i),
        atrAbs: new Float64Array(n).fill(2),
        gap: Uint8Array.from({ length: n }, (_, i) => (i % 5 === 0 ? 1 : 0)),
        atrQuintile: new Int8Array(n).fill(2),
        month: new Int32Array(n),
        warmupBars: 0,
        finiteShare: SNIPE_COLUMNS.map((_, c) => (c === 1 ? 0.25 + 0.5 * k : 1)),
      };
    });
    const ctx = stats.buildSliceContext(arrays, discoverySlice(), 'intraday', 86_400_000);
    const b = sanityOnlyBlockOf(ctx, FIXTURE_SYMBOLS.slice(0, 2));
    expect(b.inSliceBars).toBe(60);
    expect(b.gapLabels).toBe(2 * 6);
    expect(b.columns[0].tailEligibleShare).toBe(1);
    expect(b.columns[1].tailEligibleShare).toBe(0);
    expect(b.columns[1].finiteShareBySymbol).toEqual([0.25, 0.75]);
    expect(b.columns[1].finiteShare).toBeCloseTo(0.5, 12);
    expect(b.sample).toHaveLength(20);
    for (const s of b.sample) {
      const i = Math.round((Date.parse(s.conditionTime) - Date.UTC(2022, 5, 1)) / 86_400_000);
      expect(s.entryPrice).toBe(100 + i);
      expect(s.upper).toBe(100 + i + 2);
      expect(s.lower).toBe(100 + i - 2);
    }
  });

  it('parses --sanity-only without a value and rejects --cell or --draws with it', () => {
    const a = parseArgs(['--cache-dir', 'c', '--sanity-only', '--out', 'o.json']);
    expect(a.sanityOnly).toBe(true);
    expect(a.out).toBe('o.json');
    expect(parseArgs(['--cache-dir', 'c', '--out', 'o.json']).sanityOnly).toBe(false);
    expect(() => parseArgs(['--cache-dir', 'c', '--sanity-only', '--cell', 'raw.ret1:top:many:scalp'])).toThrow(/--cell/);
    expect(() => parseArgs(['--cache-dir', 'c', '--sanity-only', '--out', 'o', '--draws', '5'])).toThrow(/--draws/);
    expect(() => parseArgs(['--cache-dir', 'c', '--sanity-only'])).toThrow(/--out/);
  });
});
