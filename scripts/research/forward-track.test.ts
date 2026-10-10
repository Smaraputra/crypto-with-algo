// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  datasetHashOf, LOCKBOX_START_ISO, sha256File, writeJsonlGz,
  type CandleRow, type DatasetManifest, type FlowRow, type HtfRow, type ManifestFile, type PerpCandleRow,
} from './dataset-format';
import { writeSnipeFixture } from './snipe-fixture';
import { TRACK_FORWARD_FROM, TRACK_SPAN } from './forward-track';
import {
  directedCi,
  directedExcess,
  directionalACell,
  indexRange,
  monthLabel,
  trackBCell,
  trackMonths,
  trackPeriods,
  type SymbolSeries,
} from './forward-track-stats';
import { buildAArrays, formatTable, loadBSeries, parseForwardTrackArgs } from './forward-track-run';
import { OUTCOME_DOWN, OUTCOME_UP } from './snipe-labels';
import type { SnipeSymbolArrays } from './snipe-matrix';
import { sliceView } from './snipe-stats';
import { TAIL_ELIGIBLE, TAIL_TOP_10 } from './snipe-tails';

describe('forward-track months and labels', () => {
  it('iterates every UTC month from 2025-10 to 2026-10 with the last one cut at the span end', () => {
    const m = trackMonths();
    expect(m).toHaveLength(13);
    expect(m[0].id).toBe('2025-10');
    expect(m[0].startMs).toBe(Date.UTC(2025, 9, 1));
    expect(m[0].endMs).toBe(Date.UTC(2025, 10, 1) - 1);
    expect(m[3].id).toBe('2026-01');
    expect(m[12].id).toBe('2026-10');
    expect(m[12].endMs).toBe(Date.parse(TRACK_SPAN.end));
    for (let i = 1; i < m.length; i++) expect(m[i].startMs).toBe(m[i - 1].endMs + 1);
  });

  it('labels forward from 2026-07 and used-before earlier, and the year row mixed', () => {
    expect(TRACK_FORWARD_FROM).toBe('2026-07');
    expect(monthLabel('2026-06')).toBe('used-before');
    expect(monthLabel('2026-07')).toBe('forward');
    expect(monthLabel('2026-10')).toBe('forward');
    const p = trackPeriods();
    expect(p.filter((x) => x.label === 'forward').map((x) => x.id)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);
    expect(p.filter((x) => x.label === 'used-before')).toHaveLength(9);
    expect(p[p.length - 1]).toMatchObject({ id: 'year', label: 'mixed', startMs: Date.parse('2025-10-10T00:00:00.000Z') });
  });

  it('crosses a year boundary', () => {
    const m = trackMonths('2025-11', '2026-02-15T00:00:00.000Z');
    expect(m.map((x) => x.id)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(m[3].endMs).toBe(Date.parse('2026-02-15T00:00:00.000Z'));
  });
});

describe('direction mapping', () => {
  it('a short has minus the long excess and a negated, swapped interval', () => {
    expect(directedExcess(0.02, 1)).toBe(0.02);
    expect(directedExcess(0.02, -1)).toBe(-0.02);
    expect(directedCi([-0.01, 0.03], 1)).toEqual([-0.01, 0.03]);
    expect(directedCi([-0.01, 0.03], -1)).toEqual([-0.03, 0.01]);
  });

  it('directionalACell maps win rate, baseline and excess for a short', () => {
    // 4 flagged bars, all resolved: 3 down (short wins), 1 up. Baseline long rate 0.5 everywhere.
    const n = 8;
    const ts = Float64Array.from({ length: n }, (_, i) => 1_000_000 + i * 300_000);
    const outcome = Int8Array.from([OUTCOME_DOWN, OUTCOME_UP, OUTCOME_DOWN, OUTCOME_DOWN, OUTCOME_UP, OUTCOME_DOWN, OUTCOME_UP, OUTCOME_UP]);
    const flags = new Uint8Array(n);
    for (const i of [0, 1, 2, 3]) flags[i] = TAIL_ELIGIBLE | TAIL_TOP_10;
    const arrays = {
      symbol: 'X',
      timeframe: 'scalp',
      columns: ['raw.rsi'],
      timestamps: ts,
      flags: [flags],
      outcome,
      entryMs: Float64Array.from(ts, (t) => t + 300_000),
      exitMs: Float64Array.from(ts, (t) => t + 300_000),
      atrPct: new Float64Array(n).fill(0.2),
      atrQuintile: new Int8Array(n).fill(0),
    } as unknown as SnipeSymbolArrays;
    const view = sliceView(arrays, { startMs: 0, endMs: 1e12 }, 3_600_000);
    const short = directionalACell([view], 'raw.rsi', TAIL_TOP_10, -1, { resamples: 50, seed: 1 });
    const long = directionalACell([view], 'raw.rsi', TAIL_TOP_10, 1, { resamples: 50, seed: 1 });
    expect(short.resolved).toBe(4);
    expect(long.winRate).toBeCloseTo(0.25);
    expect(short.winRate).toBeCloseTo(0.75);
    expect(long.baseline).toBeCloseTo(0.5);
    expect(short.baseline).toBeCloseTo(0.5);
    expect(short.excess).toBeCloseTo(0.25);
    expect(long.excess).toBeCloseTo(-0.25);
    expect(short.excess).toBeCloseTo(short.winRate - short.baseline);
    expect(short.ci[0]).toBeLessThanOrEqual(short.ci[1]);
    expect(short.makerBreakEven).toBeGreaterThan(0.5);
    expect(short.takerBreakEven).toBeGreaterThan(short.makerBreakEven);
  });

  it('a slice without flagged bars is empty, not an error', () => {
    const arrays = {
      symbol: 'X', timeframe: 'scalp', columns: ['raw.rsi'], timestamps: new Float64Array(0), flags: [new Uint8Array(0)],
      outcome: new Int8Array(0), entryMs: new Float64Array(0), exitMs: new Float64Array(0),
      atrPct: new Float64Array(0), atrQuintile: new Int8Array(0),
    } as unknown as SnipeSymbolArrays;
    const c = directionalACell([sliceView(arrays, { startMs: 0, endMs: 1 }, 1)], 'raw.rsi', TAIL_TOP_10, -1, { resamples: 10, seed: 1 });
    expect(c.taken).toBe(0);
    expect(Number.isNaN(c.excess)).toBe(true);
  });
});

describe('B month filter', () => {
  const HOUR = 3_600_000;
  const t0 = Date.UTC(2026, 0, 30);
  function make(symbol: string, sign: number, seed: number): SymbolSeries {
    const n = 24 * 6;
    let s = seed;
    const rnd = (): number => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5;
    const timestamps = Float64Array.from({ length: n }, (_, i) => t0 + i * HOUR);
    const factor = Float64Array.from({ length: n }, () => rnd());
    // January bars carry the opposite relation to February bars.
    const fwd = Float64Array.from(factor, (v, i) => (timestamps[i] < Date.UTC(2026, 1, 1) ? sign * v : -sign * v) + rnd() * 0.01);
    return { symbol, timestamps, factor, fwd };
  }

  it('indexRange is by the signal bar timestamp, inclusive at both ends', () => {
    const ts = Float64Array.from([10, 20, 30, 40]);
    expect(indexRange(ts, 20, 30)).toEqual([1, 3]);
    expect(indexRange(ts, 0, 5)).toEqual([0, 0]);
    expect(indexRange(ts, 41, 50)).toEqual([4, 4]);
  });

  it('uses only pairs whose signal bar is in the month, and counts negative symbols', () => {
    const series = [make('A', -1, 1), make('B', -1, 2), make('C', 1, 3)];
    const jan = trackBCell(series, Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1) - 1, 1);
    const feb = trackBCell(series, Date.UTC(2026, 1, 1), Date.UTC(2026, 2, 1) - 1, 1);
    expect(jan.n).toBeGreaterThan(0);
    expect(jan.n + feb.n).toBeLessThanOrEqual(3 * 24 * 6);
    expect(jan.perSymbol.map((p) => p.symbol)).toEqual(['A', 'B', 'C']);
    expect(jan.negativeSymbols).toBe(2);
    expect(feb.negativeSymbols).toBe(1);
    expect(jan.ic).toBeLessThan(0.2);
    // January symbols A and B are strongly negative, February flips them.
    expect(jan.perSymbol[0].ic!).toBeLessThan(-0.9);
    expect(feb.perSymbol[0].ic!).toBeGreaterThan(0.9);
    const empty = trackBCell(series, Date.UTC(2027, 0, 1), Date.UTC(2027, 1, 1), 1);
    expect(empty.n).toBe(0);
    expect(Number.isNaN(empty.ic)).toBe(true);
    expect(empty.negativeSymbols).toBe(0);
  });
});

describe('forward-track cli', () => {
  it('parses flags and prints a table', () => {
    const a = parseForwardTrackArgs(['--dataset-dir', 'd', '--out', 'o.json']);
    expect(a.symbols).toHaveLength(10);
    expect(parseForwardTrackArgs(['--dataset-dir', 'd', '--out', 'o', '--symbols', 'BTCUSDT']).symbols).toEqual(['BTCUSDT']);
    expect(() => parseForwardTrackArgs(['--out', 'o'])).toThrow(/--dataset-dir/);
    expect(() => parseForwardTrackArgs(['--dataset-dir', 'd'])).toThrow(/--out/);
    expect(formatTable([])).toHaveLength(1);
  });
});

describe('forward-track loaders on synthetic fixtures', () => {
  let dirA: string;
  let dirB: string;
  const HOUR = 3_600_000;
  const FIVE = 300_000;
  const START = Date.UTC(2026, 5, 20);
  const BARS = Math.round((Date.UTC(2026, 9, 10) - START) / HOUR);

  beforeAll(async () => {
    dirA = mkdtempSync(join(tmpdir(), 'forward-track-a-'));
    await writeSnipeFixture(dirA, ['BTCUSDT', 'ETHUSDT'], [4242, 777], 63_936);

    dirB = mkdtempSync(join(tmpdir(), 'forward-track-b-'));
    const files: ManifestFile[] = [];
    const add = async (kind: ManifestFile['kind'], symbol: string, interval: string, rows: { t: number }[]) => {
      const rel = `${kind}/${symbol}/${interval}.jsonl.gz`;
      mkdirSync(dirname(join(dirB, rel)), { recursive: true });
      await writeJsonlGz(join(dirB, rel), rows);
      files.push({
        path: rel, kind, symbol, interval, rowCount: rows.length,
        startMs: rows.length ? rows[0].t : null, endMs: rows.length ? rows[rows.length - 1].t : null,
        sha256: await sha256File(join(dirB, rel)),
      });
    };
    let seed = 99;
    const next = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const eps: number[] = [];
    for (let i = 0; i < BARS + 3; i++) eps.push((next() - 0.5) * 0.02);
    const candles: CandleRow[] = [];
    let price = 100;
    for (let i = 0; i < BARS; i++) {
      const close = price * (1 + eps[i]);
      candles.push({ t: START + i * HOUR, o: price, h: Math.max(price, close) * 1.001, l: Math.min(price, close) * 0.999, c: close, v: 1000, tbv: 500 });
      price = close;
    }
    const flow: FlowRow[] = [];
    for (let i = 0; i < BARS; i++) {
      const lean = -(eps[i + 1] + eps[i + 2]) * 400 + (next() - 0.5) * 30;
      for (let k = 0; k < 12; k++) {
        const d = lean / 12;
        flow.push({
          t: START + i * HOUR + k * FIVE, trades: 100, aggTrades: 100, buyBase: 1, sellBase: 1,
          buyQuote: 500 + d / 2, sellQuote: 500 - d / 2, buyQuoteSmall: 200 + d / 2, buyQuoteMedium: 150, buyQuoteLarge: 150,
          sellQuoteSmall: 200 - d / 2, sellQuoteMedium: 150, sellQuoteLarge: 150,
          buyQuoteOpen10s: 10 + next(), sellQuoteOpen10s: 10 + next(), source: 'test',
        });
      }
    }
    await add('candles', 'BTCUSDT', '1h', candles);
    await add('snapshots', 'BTCUSDT', '1h', []);
    await add('htf', 'BTCUSDT', '1h', candles.map((c): HtfRow => ({ t: c.t, context: null })));
    await add('perp', 'BTCUSDT', '1h', candles.map((c): PerpCandleRow => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c * 1.01, v: c.v, qv: c.v * c.c, n: 100, tbv: c.tbv })));
    await add('flow', 'BTCUSDT', '5m', flow);
    const manifest: DatasetManifest = {
      version: 1, generatedAt: new Date().toISOString(), commit: 'test-fixture', lockboxStart: LOCKBOX_START_ISO,
      symbols: ['BTCUSDT'], intervals: ['1h', '5m'], files, datasetHash: datasetHashOf(files),
    };
    writeFileSync(join(dirB, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }, 120_000);
  afterAll(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('A: builds reduced arrays and every period yields a cell, empty before the data', () => {
    const arrays = buildAArrays(dirA, ['BTCUSDT', 'ETHUSDT'], Date.parse(TRACK_SPAN.dataStart), Date.parse(TRACK_SPAN.end));
    expect(arrays).toHaveLength(2);
    expect(arrays[0].columns).toEqual(['raw.rsi']);
    const maxHold = 3_600_000;
    let resolved = 0;
    for (const p of trackPeriods()) {
      const views = arrays.map((a) => sliceView(a, { startMs: p.startMs, endMs: p.endMs }, maxHold));
      const top = directionalACell(views, 'raw.rsi', TAIL_TOP_10, -1, { resamples: 20, seed: 11 });
      if (p.id === '2025-10') expect(top.taken).toBe(0);
      resolved += top.resolved;
    }
    expect(resolved).toBeGreaterThan(0);
  });

  it('B: loads the small-taker column and forward returns, and the month IC is negative', () => {
    const series = loadBSeries(dirB, ['BTCUSDT'], Date.parse(TRACK_SPAN.dataStart), Date.parse(TRACK_SPAN.end));
    expect(series).toHaveLength(1);
    expect(series[0].timestamps.length).toBe(series[0].fwd.length);
    const aug = trackBCell(series, Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1) - 1, 1);
    expect(aug.n).toBeGreaterThan(500);
    expect(aug.ic).toBeLessThan(-0.1);
    expect(aug.negativeSymbols).toBe(1);
    const before = trackBCell(series, Date.UTC(2025, 9, 1), Date.UTC(2025, 10, 1) - 1, 1);
    expect(before.n).toBe(0);
  });
});
