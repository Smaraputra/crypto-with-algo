// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createSeededRandom } from '@/lib/stats/seeded-random';
import {
  datasetHashOf,
  sha256File,
  writeJsonlGz,
  type DatasetManifest,
  type FundingRow,
  type ManifestFile,
  type PerpCandleRow,
} from './dataset-format';
import { stableStringify } from './broad-trend';
import {
  RV_SYMBOLS,
  alignPanel,
  assemblePanel,
  buildRvPanel,
  crossCheck1h,
  fundingFlags,
  fundingPerBar,
  pairTo8h,
  panelGrid,
  resolveFlags,
  type ResolutionEntry,
  type RvSymbolSource,
} from './rv-panel';
import { verifyResolutions, type FundingFetcher, type VerifiedResolutions } from './rv-resolutions';

const H = 3_600_000;
const H4 = 4 * H;
const H8 = 8 * H;
const DAY = 24 * H;
const T0 = Date.UTC(2022, 0, 1);

const noEvent = (symbol: string, t: number, restBefore: number, restAfter: number): ResolutionEntry => ({
  symbol,
  t,
  verdict: 'no-event',
  restBefore,
  restAfter,
});

/** A REST stand-in that settled exactly at the given instants per symbol. */
const restAt = (bySymbol: Record<string, number[]>): FundingFetcher => async (symbol, startTime, endTime) =>
  (bySymbol[symbol] ?? []).filter((t) => t >= startTime && t <= endTime).map((fundingTime) => ({ fundingTime }));

/**
 * Resolutions as the panel accepts them (AMENDMENT 3): through verifyResolutions. By default REST settled at
 * each entry's recorded neighbours and nowhere else, so the REST re-check passes.
 */
const verified = (entries: ResolutionEntry[] = [], rest?: FundingFetcher): Promise<VerifiedResolutions> => {
  const times: Record<string, number[]> = {};
  for (const e of entries) times[e.symbol] = [...(times[e.symbol] ?? []), e.restBefore, e.restAfter];
  return verifyResolutions({ sha256: 'f'.repeat(64), entries }, rest ?? restAt(times));
};

/** Eight 1h rows per 8h bucket, a seeded random walk, prices strictly positive. */
function hourly(buckets: number, seed: number, from = T0): PerpCandleRow[] {
  const random = createSeededRandom(seed);
  const rows: PerpCandleRow[] = [];
  let price = 100 + seed;
  for (let i = 0; i < buckets * 8; i++) {
    const o = price;
    const c = o * (1 + (random() - 0.5) * 0.01);
    const h = Math.max(o, c) * (1 + random() * 0.004);
    const l = Math.min(o, c) * (1 - random() * 0.004);
    const v = 100 + random() * 900;
    rows.push({ t: from + i * H, o, h, l, c, v, qv: v * o, n: 50, tbv: v * (0.3 + random() * 0.4) });
    price = c;
  }
  return rows;
}

/** 4h rows aggregated from 1h rows. Volumes carry a relative 1e-12 offset, as an exchange aggregate differs from a float sum in its last bits. */
function fourHourly(rows1h: PerpCandleRow[]): PerpCandleRow[] {
  const out: PerpCandleRow[] = [];
  for (let i = 0; i + 4 <= rows1h.length; i += 4) {
    const g = rows1h.slice(i, i + 4);
    const rev = [...g].reverse();
    out.push({
      t: g[0].t,
      o: g[0].o,
      h: Math.max(...g.map((r) => r.h)),
      l: Math.min(...g.map((r) => r.l)),
      c: g[3].c,
      v: rev.reduce((s, r) => s + r.v, 0) * (1 + 1e-12),
      qv: rev.reduce((s, r) => s + r.qv, 0),
      n: g.reduce((s, r) => s + r.n, 0),
      tbv: rev.reduce((s, r) => s + (r.tbv as number), 0) * (1 + 1e-12),
    });
  }
  return out;
}

function grid8(from: number, to: number, hours = 8, rate = (t: number) => 0.0001 + (t % 7) * 1e-6, stated = true): FundingRow[] {
  const out: FundingRow[] = [];
  for (let t = from; t <= to; t += hours * H) out.push({ t, rate: rate(t), intervalHours: stated ? hours : null });
  return out;
}

describe('pairTo8h (header DATA: 4h perp klines paired into 8h bars at 00, 08 and 16 UTC)', () => {
  it('pairs the two 4h halves into one 8h bar that opens at 00, 08 or 16 UTC', () => {
    const r4 = fourHourly(hourly(3, 1));
    const { bars, dropped } = pairTo8h(r4, { from: T0, to: T0 + 2 * H8 });
    expect(dropped).toEqual([]);
    expect(bars.map((b) => b.t)).toEqual([T0, T0 + H8, T0 + 2 * H8]);
    expect(bars.map((b) => new Date(b.t).getUTCHours())).toEqual([0, 8, 16]);
    const [a, b] = [r4[2], r4[3]];
    expect(bars[1]).toEqual({
      t: T0 + H8,
      open: a.o,
      high: Math.max(a.h, b.h),
      low: Math.min(a.l, b.l),
      close: b.c,
      volume: a.v + b.v,
      tbv: (a.tbv as number) + (b.tbv as number),
    });
  });

  it('never pairs across a bucket boundary: a series starting at 04:00 drops the 00:00 bucket', () => {
    const r4 = fourHourly(hourly(3, 2)).slice(1);
    const { bars, dropped } = pairTo8h(r4, { from: T0, to: T0 + 2 * H8 });
    expect(bars.map((b) => b.t)).toEqual([T0 + H8, T0 + 2 * H8]);
    expect(dropped).toEqual([T0]);
  });

  it('drops and counts every grid bucket missing either half, including one missing both', () => {
    const r4 = fourHourly(hourly(4, 3)).filter((r) => r.t !== T0 + H8 + H4 && r.t !== T0 + 2 * H8 && r.t !== T0 + 2 * H8 + H4);
    const { bars, dropped } = pairTo8h(r4, { from: T0, to: T0 + 3 * H8 });
    expect(bars.map((b) => b.t)).toEqual([T0, T0 + 3 * H8]);
    expect(dropped).toEqual([T0 + H8, T0 + 2 * H8]);
  });

  it('ignores rows outside the grid without counting them', () => {
    const r4 = fourHourly(hourly(4, 4));
    const { bars, dropped } = pairTo8h(r4, { from: T0 + H8, to: T0 + 2 * H8 });
    expect(bars.map((b) => b.t)).toEqual([T0 + H8, T0 + 2 * H8]);
    expect(dropped).toEqual([]);
  });

  it('carries a null taker-buy volume through as null so the panel can halt on it', () => {
    const r4 = fourHourly(hourly(2, 5));
    r4[1] = { ...r4[1], tbv: null };
    const { bars } = pairTo8h(r4, { from: T0, to: T0 + H8 });
    expect(bars[0].tbv).toBeNull();
    expect(bars[1].tbv).not.toBeNull();
  });

  it('halts on a non-finite or non-positive price and on a negative or non-finite volume or taker-buy volume (AMENDMENT 2)', () => {
    const r4 = fourHourly(hourly(2, 7));
    const grid = { from: T0, to: T0 + H8 };
    const bad: Partial<PerpCandleRow>[] = [
      { o: Number.NaN },
      { h: Number.POSITIVE_INFINITY },
      { l: 0 },
      { c: -1 },
      { v: -1 },
      { v: Number.NaN },
      { tbv: -0.5 },
      { tbv: Number.POSITIVE_INFINITY },
      { v: 0, tbv: 0 }, // AMENDMENT 3: zero volume
      { tbv: r4[2].v * 1.000001 }, // AMENDMENT 3: taker-buy volume above volume
    ];
    for (const patch of bad) {
      const rows = r4.map((r, i) => (i === 2 ? { ...r, ...patch } : r));
      expect(() => pairTo8h(rows, grid), JSON.stringify(patch)).toThrow(/HALT/);
    }
  });

  it('throws on a row off the 4h grid, a duplicate row, or a grid not on 8h boundaries', () => {
    const r4 = fourHourly(hourly(2, 6));
    expect(() => pairTo8h([...r4, { ...r4[0], t: T0 + H }], { from: T0, to: T0 + H8 })).toThrow(/4h grid/);
    expect(() => pairTo8h([...r4, r4[1]], { from: T0, to: T0 + H8 })).toThrow(/duplicate/i);
    expect(() => pairTo8h(r4, { from: T0 + H4, to: T0 + H8 })).toThrow(/8h boundar/);
  });
});

describe('fundingPerBar (header DATA: per-bar funding is the sum of settlements in (bar open, bar close])', () => {
  const bars = [0, 1, 2].map((k) => ({ t: T0 + k * H8, open: 1, high: 1, low: 1, close: 1, volume: 1, tbv: 0.5 }));

  it('sums the settlements in (open, close] across an 8h-to-4h interval switch', () => {
    const s: FundingRow[] = [
      { t: T0, rate: 0.9, intervalHours: 8 },
      { t: T0 + H8, rate: 0.001, intervalHours: 8 },
      { t: T0 + 12 * H, rate: 0.002, intervalHours: 4 },
      { t: T0 + 16 * H, rate: 0.003, intervalHours: 4 },
      { t: T0 + 20 * H, rate: -0.004, intervalHours: 4 },
      { t: T0 + 24 * H, rate: 0.005, intervalHours: 4 },
    ];
    const f = fundingPerBar(bars, s);
    expect(f.fundSum[0]).toBeCloseTo(0.001, 15);
    expect(f.fundSum[1]).toBeCloseTo(0.005, 15);
    expect(f.fundSum[2]).toBeCloseTo(0.001, 15);
    expect(f.fundCount).toEqual([1, 2, 2]);
    expect(f.fundLast).toEqual([0.001, 0.003, 0.005]);
  });

  it('fundLast is the latest rate in (close - 8h, close], else null, and a settlement at the open belongs to the bar before', () => {
    const s: FundingRow[] = [
      { t: T0 + H8, rate: 0.001, intervalHours: 8 },
      { t: T0 + 20 * H, rate: 0.002, intervalHours: 4 },
    ];
    const f = fundingPerBar(bars, s);
    expect(f.fundLast).toEqual([0.001, null, 0.002]);
    expect(f.fundSum).toEqual([0.001, 0, 0.002]);
    expect(f.fundCount).toEqual([1, 0, 1]);
  });

  it('is independent of the order the settlements arrive in', () => {
    const s = grid8(T0, T0 + 3 * H8);
    expect(fundingPerBar(bars, [...s].reverse())).toEqual(fundingPerBar(bars, s));
  });
});

describe('fundingFlags (header DATA and AMENDMENTS 1 and 2: settlements that need a REST-verified resolution)', () => {
  const window = { from: T0, to: T0 + 6 * DAY };
  const nul = (rows: FundingRow[]) => rows.map((r) => ({ ...r, intervalHours: null }));
  const missing = (...ts: number[]) => ts.map((t) => ({ symbol: 'X', t, reason: 'missing' }));
  const flag = (t: number, reason: 'missing' | 'derived-switch') => ({ symbol: 'X', t, reason });

  it('flags nothing on a complete 8h grid with stated intervals', () => {
    expect(fundingFlags('X', grid8(T0 + H8, T0 + 6 * DAY), window)).toEqual([]);
  });

  it('flags a missing settlement inside the window, at its head and at its tail', () => {
    const full = grid8(T0 + H8, T0 + 6 * DAY);
    expect(fundingFlags('X', full.filter((r) => r.t !== T0 + 2 * DAY + H8), window)).toEqual(missing(T0 + 2 * DAY + H8));
    expect(fundingFlags('X', full.filter((r) => r.t !== T0 + H8), window)).toEqual(missing(T0 + H8));
    expect(fundingFlags('X', full.filter((r) => r.t !== T0 + 6 * DAY), window)).toEqual(missing(T0 + 6 * DAY));
  });

  it('does not require a settlement at the window open or after the window close', () => {
    const rows = [{ t: T0, rate: 0.0001, intervalHours: 8 }, ...grid8(T0 + H8, T0 + 6 * DAY)];
    expect(fundingFlags('X', rows, window)).toEqual([]);
    expect(fundingFlags('X', grid8(T0 + H8, T0 + 6 * DAY), { from: T0, to: T0 + 6 * DAY - 16 * H })).toEqual([]);
  });

  it('reads stated intervals: an 8h-to-4h switch is complete and a missing 4h settlement is flagged', () => {
    const switched = [...grid8(T0 + H8, T0 + 3 * DAY), ...grid8(T0 + 3 * DAY + H4, T0 + 6 * DAY, 4)];
    expect(fundingFlags('X', switched, window)).toEqual([]);
    expect(fundingFlags('X', switched.filter((r) => r.t !== T0 + 4 * DAY + 12 * H), window)).toEqual(missing(T0 + 4 * DAY + 12 * H));
  });

  it('derives a null interval from the spacing and flags lone long gaps (REST rows)', () => {
    const eight = nul(grid8(T0 + H8, T0 + 6 * DAY));
    expect(fundingFlags('X', eight, window)).toEqual([]);
    expect(fundingFlags('X', eight.filter((r) => r.t !== T0 + 2 * DAY + H8), window)).toEqual(missing(T0 + 2 * DAY + H8));
    expect(fundingFlags('X', eight.filter((r) => r.t !== T0 + 2 * DAY + H8 && r.t !== T0 + 2 * DAY + 2 * H8), window)).toEqual(
      missing(T0 + 2 * DAY + H8, T0 + 2 * DAY + 2 * H8)
    );
  });

  it('flags every interval switch derived from null-interval spacing, inside the longer gap at the switch (AMENDMENT 2)', () => {
    // Shortening 8h to 4h at T0 + 3d: was 4h already in force across the last 8h gap? REST must say no at T0 + 3d - 4h
    const shortened = nul([...grid8(T0 + H8, T0 + 3 * DAY), ...grid8(T0 + 3 * DAY + H4, T0 + 6 * DAY, 4)]);
    expect(fundingFlags('X', shortened, window)).toEqual([flag(T0 + 3 * DAY - H4, 'derived-switch')]);
    // Lengthening 4h to 8h after T0 + 3d: was 4h still in force across the first 8h gap? REST must say no at T0 + 3d + 4h
    const lengthened = nul([...grid8(T0 + H4, T0 + 3 * DAY, 4), ...grid8(T0 + 3 * DAY + H8, T0 + 6 * DAY)]);
    expect(fundingFlags('X', lengthened, window)).toEqual([flag(T0 + 3 * DAY + H4, 'derived-switch')]);
    // A lone missing 4h settlement after the switch is a missing flag beside the switch flag
    expect(fundingFlags('X', shortened.filter((r) => r.t !== T0 + 4 * DAY + 12 * H), window)).toEqual([
      flag(T0 + 3 * DAY - H4, 'derived-switch'),
      flag(T0 + 4 * DAY + 12 * H, 'missing'),
    ]);
    // Stated intervals: the same switches carry no switch flag
    expect(fundingFlags('X', [...grid8(T0 + H4, T0 + 3 * DAY, 4), ...grid8(T0 + 3 * DAY + H8, T0 + 6 * DAY)], window)).toEqual([]);
  });

  it('flags a switch between a stated row and a derived one in either order (review m12)', () => {
    // Archive rows (stated 8h) followed by REST-synced rows (null, 4h spacing)
    const statedThenNull = [...grid8(T0 + H8, T0 + 3 * DAY), ...nul(grid8(T0 + 3 * DAY + H4, T0 + 6 * DAY, 4))];
    expect(fundingFlags('X', statedThenNull, window)).toEqual([flag(T0 + 3 * DAY - H4, 'derived-switch')]);
    // REST-synced rows (null, 8h spacing) followed by archive rows (stated 4h)
    const nullThenStated = [...nul(grid8(T0 + H8, T0 + 3 * DAY)), ...grid8(T0 + 3 * DAY + H4, T0 + 6 * DAY, 4)];
    expect(fundingFlags('X', nullThenStated, window)).toEqual([flag(T0 + 3 * DAY - H4, 'derived-switch')]);
  });

  it('a missing first settlement after a null-interval switch is flagged, not read as a later switch (review m1)', () => {
    // True switch to 4h at T0 + 3d with T0 + 3d + 4h missing: gaps 8, 8, 8, 4 look like a switch one settlement later
    const rows = nul([...grid8(T0 + H8, T0 + 3 * DAY), ...grid8(T0 + 3 * DAY + H4, T0 + 6 * DAY, 4)]).filter((r) => r.t !== T0 + 3 * DAY + H4);
    expect(fundingFlags('X', rows, window)).toEqual([flag(T0 + 3 * DAY + H4, 'derived-switch')]);
    // The same rows with stated intervals flag it as missing
    const stated = [...grid8(T0 + H8, T0 + 3 * DAY), ...grid8(T0 + 3 * DAY + H4, T0 + 6 * DAY, 4)].filter((r) => r.t !== T0 + 3 * DAY + H4);
    expect(fundingFlags('X', stated, window)).toEqual(missing(T0 + 3 * DAY + H4));
  });

  it('flags both instants of the alternating pattern that 1874533 let pass (4h gaps 4, 8, 8, 4 with null intervals)', () => {
    const rows = nul(grid8(T0 + H4, T0 + 2 * DAY + H8, 4)).filter((r) => r.t !== T0 + DAY + 12 * H && r.t !== T0 + DAY + 20 * H);
    expect(fundingFlags('X', rows, { from: T0, to: T0 + 2 * DAY + H8 })).toEqual([
      flag(T0 + DAY + 12 * H, 'derived-switch'),
      flag(T0 + DAY + 20 * H, 'derived-switch'),
    ]);
  });

  it('judges a lone long null-interval gap at its smallest Binance-interval neighbour (review m1, PA16)', () => {
    // 4h spacing to A, one 8h gap, then 2h spacing: the 8h gap is judged at 2h, not 4h
    const A = T0 + DAY;
    const rows = nul([...grid8(T0 + H4, A, 4), ...grid8(A + H8, T0 + 2 * DAY, 2)]);
    expect(fundingFlags('X', rows, { from: T0, to: T0 + 2 * DAY })).toEqual([
      flag(A - 2 * H, 'derived-switch'),
      flag(A + 2 * H, 'missing'),
      flag(A + 4 * H, 'missing'),
      flag(A + 6 * H, 'missing'),
    ]);
  });

  it('halts when the interval cannot be derived, on a duplicate settlement, a time off the hour, or a non-finite rate', () => {
    expect(() => fundingFlags('X', [{ t: T0 + H8, rate: 0.0001, intervalHours: null }], { from: T0, to: T0 + H8 })).toThrow(/HALT[\s\S]*interval/);
    const rows = grid8(T0 + H8, T0 + 6 * DAY);
    expect(() => fundingFlags('X', [...rows, rows[3]], window)).toThrow(/HALT[\s\S]*duplicate/i);
    expect(() => fundingFlags('X', [...rows.slice(0, 3), { ...rows[3], t: rows[3].t + 1 }, ...rows.slice(4)], window)).toThrow(/HALT[\s\S]*hour/);
    expect(() => fundingFlags('X', rows.map((r, i) => (i === 4 ? { ...r, rate: Number.NaN } : r)), window)).toThrow(/HALT[\s\S]*rate/);
  });

  it('halts when no settlement exists at all, or none inside the window', () => {
    expect(() => fundingFlags('X', [], window)).toThrow(/HALT[\s\S]*no settlement/i);
    expect(() => fundingFlags('X', grid8(T0 + 7 * DAY, T0 + 8 * DAY), window)).toThrow(/HALT[\s\S]*no settlement/i);
  });
});

describe('alignPanel (rectangular panel: timestamps every symbol carries)', () => {
  it('keeps the intersection of timestamps, in time order, with every column aligned', () => {
    const k = (i: number) => T0 + i * H8;
    const mk = (symbol: string, idx: number[]) => ({
      symbol,
      bars: idx.map((i) => ({ t: k(i), open: i + 1, high: i + 2, low: i + 0.5, close: i + 1.5, volume: 10, tbv: 4 })),
      fundSum: idx.map((i) => i / 1000),
      fundLast: idx.map((i) => (i === 3 ? null : i / 1000)),
    });
    const { panel, droppedTimestamps } = alignPanel([mk('A', [0, 1, 2, 3, 4]), mk('B', [1, 2, 3, 4, 5]), mk('C', [0, 1, 3, 4])]);
    expect(panel.symbols).toEqual(['A', 'B', 'C']);
    expect(panel.t).toEqual([k(1), k(3), k(4)]);
    expect(panel.open[1]).toEqual([2, 4, 5]);
    expect(panel.close[2]).toEqual([2.5, 4.5, 5.5]);
    expect(panel.fundSum[0]).toEqual([0.001, 0.003, 0.004]);
    expect(panel.fundLast[0]).toEqual([0.001, null, 0.004]);
    expect(droppedTimestamps).toEqual([k(0), k(2), k(5)]);
  });
});

function sourceFor(symbol: string, seed: number, buckets: number, from = T0): RvSymbolSource {
  const rows1h = hourly(buckets, seed, from);
  return {
    symbol,
    rows4h: fourHourly(rows1h),
    rows1h,
    funding: grid8(from + H8, from + buckets * H8 - 1),
  };
}

describe('crossCheck1h (header DATA: 8h from 4h must equal 8h from 1h)', () => {
  function panelOf(src: RvSymbolSource, buckets: number) {
    const { bars } = pairTo8h(src.rows4h, { from: T0, to: T0 + (buckets - 1) * H8 });
    const f = fundingPerBar(bars, src.funding);
    return alignPanel([{ symbol: src.symbol, bars, fundSum: f.fundSum, fundLast: f.fundLast }]).panel;
  }

  it('finds no mismatch on a fixture whose 4h volumes are float sums in another order', () => {
    const src = sourceFor('A', 11, 6);
    const panel = panelOf(src, 6);
    // The fixture must exercise the tolerance: some 8h volume differs in its last bits between the two builds
    const forward = (k: number) => src.rows1h.slice(8 * k, 8 * k + 8).reduce((s, r) => s + r.v, 0);
    expect(panel.volume[0].some((v, k) => v !== forward(k))).toBe(true);
    expect(crossCheck1h(panel, { A: src.rows1h })).toEqual([]);
  });

  it('reports any OHLC difference exactly (one ulp), and volume or taker-buy volume beyond a relative 1e-7', () => {
    const src = sourceFor('A', 12, 6);
    const panel = panelOf(src, 6);
    const r1 = src.rows1h.map((r) => ({ ...r }));
    const top = 8 + r1.slice(8, 16).reduce((best, r, j, all) => (r.h > all[best].h ? j : best), 0);
    r1[top].h = r1[top].h * (1 + Number.EPSILON); // bar 1's high, raised by one ulp
    expect(r1[top].h).not.toBe(src.rows1h[top].h);
    r1[20].v = r1[20].v + panel.volume[0][2] * 2e-7;
    r1[28].tbv = (r1[28].tbv as number) + panel.tbv[0][3] * 2e-7; // just outside the tolerance
    r1[33].tbv = (r1[33].tbv as number) + panel.tbv[0][4] * 5e-8; // inside the tolerance
    const mm = crossCheck1h(panel, { A: r1 });
    expect(mm.map((m) => [m.t, m.field])).toEqual([
      [T0 + H8, 'high'],
      [T0 + 2 * H8, 'volume'],
      [T0 + 3 * H8, 'tbv'],
    ]);
  });

  it('halts on a duplicate or off-hour 1h row and on an invalid 1h price or volume (AMENDMENT 2)', () => {
    const src = sourceFor('A', 14, 6);
    const panel = panelOf(src, 6);
    expect(() => crossCheck1h(panel, { A: [...src.rows1h, src.rows1h[10]] })).toThrow(/HALT[\s\S]*duplicate/i);
    expect(() => crossCheck1h(panel, { A: [...src.rows1h, { ...src.rows1h[10], t: src.rows1h[10].t + 60_000 }] })).toThrow(/HALT[\s\S]*hour/);
    expect(() => crossCheck1h(panel, { A: src.rows1h.map((r, i) => (i === 10 ? { ...r, c: Number.NaN } : r)) })).toThrow(/HALT/);
    expect(() => crossCheck1h(panel, { A: src.rows1h.map((r, i) => (i === 10 ? { ...r, v: -1 } : r)) })).toThrow(/HALT/);
    // AMENDMENT 3: zero volume, and taker-buy volume above volume
    expect(() => crossCheck1h(panel, { A: src.rows1h.map((r, i) => (i === 10 ? { ...r, v: 0, tbv: 0 } : r)) })).toThrow(/HALT/);
    expect(() => crossCheck1h(panel, { A: src.rows1h.map((r, i) => (i === 10 ? { ...r, tbv: r.v * 1.000001 } : r)) })).toThrow(/HALT/);
  });

  it('reports a bucket the 1h series cannot rebuild, and a null 1h taker-buy volume', () => {
    const src = sourceFor('A', 13, 6);
    const panel = panelOf(src, 6);
    const r1 = src.rows1h.filter((r) => r.t !== T0 + 3 * H8 + 5 * H).map((r) => (r.t === T0 + 4 * H8 + H ? { ...r, tbv: null } : r));
    const mm = crossCheck1h(panel, { A: r1 });
    expect(mm.map((m) => [m.t, m.field])).toEqual([
      [T0 + 3 * H8, 'missing'],
      [T0 + 4 * H8, 'tbv'],
    ]);
  });
});

describe('panelGrid (the bars whose funding window lies inside the export span)', () => {
  it('ends at the last bar whose close is inside the span, so the final 16:00 bar is left out', () => {
    const g = panelGrid({ from: Date.UTC(2022, 0, 1), to: Date.UTC(2026, 9, 13, 23, 59, 59, 999) });
    expect(g.from).toBe(Date.UTC(2022, 0, 1));
    expect(g.to).toBe(Date.UTC(2026, 9, 13, 8));
  });

  it('rejects a span that does not start on an 8h boundary', () => {
    expect(() => panelGrid({ from: T0 + H, to: T0 + DAY })).toThrow(/8h boundary/);
  });
});

describe('assemblePanel (header DATA halts, AMENDMENTS 1 to 3)', () => {
  const BUCKETS = 12;
  const span = { from: T0, to: T0 + 4 * DAY - 1 };
  const sources = () => RV_SYMBOLS.map((s, i) => sourceFor(s, 100 + i, BUCKETS));

  it('builds a rectangular panel over the grid, the final 16:00 bar left out', async () => {
    const { panel, droppedBuckets, resolutions: rec } = assemblePanel(sources(), span, await verified());
    expect(panel.symbols).toEqual([...RV_SYMBOLS]);
    expect(panel.t).toHaveLength(BUCKETS - 1);
    expect(panel.t[panel.t.length - 1]).toBe(T0 + 4 * DAY - 2 * H8);
    expect(droppedBuckets).toEqual([]);
    for (const col of [panel.open, panel.high, panel.low, panel.close, panel.volume, panel.tbv, panel.fundSum, panel.fundLast]) {
      expect(col).toHaveLength(RV_SYMBOLS.length);
      for (const row of col) expect(row).toHaveLength(BUCKETS - 1);
    }
    expect(panel.fundLast.flat().every((v) => v !== null)).toBe(true);
    expect(rec).toEqual({ sha256: 'f'.repeat(64), entries: 0, flags: [] });
  });

  it('halts on any dropped bucket (AMENDMENT 2)', async () => {
    const none = await verified();
    const one = sources();
    one[1].rows4h = one[1].rows4h.filter((r) => r.t !== T0 + H8 + H4);
    expect(() => assemblePanel(one, span, none)).toThrow(/HALT[\s\S]*1 bucket\(s\) dropped[\s\S]*ETHUSDT/);
    // Two symbols dropping the same bucket is two symbol buckets on one timestamp, and still halts (review m4)
    const shared = sources();
    for (const i of [2, 5]) shared[i].rows4h = shared[i].rows4h.filter((r) => r.t !== T0 + 4 * H8);
    expect(() => assemblePanel(shared, span, none)).toThrow(/HALT[\s\S]*2 bucket\(s\) dropped/);
  });

  it('halts on a null taker-buy volume', async () => {
    const src = sources();
    src[4].rows4h[5] = { ...src[4].rows4h[5], tbv: null };
    const res1 = await verified();
    expect(() => assemblePanel(src, span, res1)).toThrow(/HALT[\s\S]*taker-buy/);
  });

  it('halts on a flagged settlement with no resolution entry', async () => {
    const src = sources();
    src[3].funding = src[3].funding.filter((r) => r.t !== T0 + 2 * DAY);
    const res2 = await verified();
    expect(() => assemblePanel(src, span, res2)).toThrow(/HALT[\s\S]*no resolution[\s\S]*SOLUSDT/);
  });

  it('matches an entry to a flag by symbol as well as instant (review m11)', async () => {
    // SOLUSDT and BTCUSDT both lack 2022-01-03 00:00, and only BTCUSDT has an entry
    const src = sources();
    for (const i of [0, 3]) src[i].funding = src[i].funding.filter((r) => r.t !== T0 + 2 * DAY);
    const btcOnly = await verified([noEvent('BTCUSDT', T0 + 2 * DAY, T0 + 2 * DAY - H8, T0 + 2 * DAY + H8)]);
    expect(() => assemblePanel(src, span, btcOnly)).toThrow(/HALT[\s\S]*no resolution entry[\s\S]*SOLUSDT/);
  });

  it('checks the funding window from the first bar\'s settlement to the last bar\'s (review m3)', async () => {
    const none = await verified();
    const first = sources();
    first[0].funding = first[0].funding.filter((r) => r.t !== T0 + H8);
    expect(() => assemblePanel(first, span, none)).toThrow(/HALT[\s\S]*no resolution/);
    const last = sources();
    last[0].funding = last[0].funding.filter((r) => r.t !== T0 + 4 * DAY - H8);
    expect(() => assemblePanel(last, span, none)).toThrow(/HALT[\s\S]*no resolution/);
  });

  it('clears a flag with an exact no-event entry: nothing is added to fundSum and the record holds the sha256 and count (AMENDMENT 1)', async () => {
    const src = sources();
    // SOLUSDT on a 4h grid with 2022-01-02 04:00 absent: the venue made no settlement there
    src[3].funding = grid8(T0 + H4, T0 + 4 * DAY - H8, 4).filter((r) => r.t !== T0 + DAY + H4);
    const gone = T0 + DAY + H4;
    const out = assemblePanel(src, span, await verified([noEvent('SOLUSDT', gone, T0 + DAY, T0 + DAY + H8)]));
    const k = out.panel.t.indexOf(T0 + DAY);
    const at8 = src[3].funding.find((r) => r.t === T0 + DAY + H8)!.rate;
    expect(out.panel.fundSum[3][k]).toBe(at8);
    expect(out.panel.fundLast[3][k]).toBe(at8);
    expect(out.resolutions).toEqual({ sha256: 'f'.repeat(64), entries: 1, flags: [{ symbol: 'SOLUSDT', t: gone, reason: 'missing' }] });
  });

  it('clears the A6-1 shortening switch when the export and REST agree on the settlements either side (AMENDMENT 3)', async () => {
    const src = sources();
    // SOLUSDT 2022-11-10 shape: stated 8h rows to 00:00, then stated 2h rows from 04:00, so 02:00 is flagged
    src[3].funding = [...grid8(T0 + H8, T0 + 2 * DAY), ...grid8(T0 + 2 * DAY + H4, T0 + 4 * DAY - H8, 2)];
    const t = T0 + 2 * DAY + 2 * H;
    const out = assemblePanel(src, span, await verified([noEvent('SOLUSDT', t, T0 + 2 * DAY, T0 + 2 * DAY + H4)]));
    expect(out.resolutions.flags).toEqual([{ symbol: 'SOLUSDT', t, reason: 'missing' }]);
  });

  it('halts when the recorded neighbours are not the export\'s own settlements either side, even though REST agrees (review I6)', async () => {
    const src = sources();
    src[3].funding = [...grid8(T0 + H8, T0 + 2 * DAY), ...grid8(T0 + 2 * DAY + H4, T0 + 4 * DAY - H8, 2)];
    const t = T0 + 2 * DAY + 2 * H;
    // REST settled at 01:00 and 03:00, which the export lacks and nothing else flags
    const entry = noEvent('SOLUSDT', t, T0 + 2 * DAY + H, T0 + 2 * DAY + 3 * H);
    const rest = restAt({ SOLUSDT: [T0 + 2 * DAY - H8, T0 + 2 * DAY, T0 + 2 * DAY + H, T0 + 2 * DAY + 3 * H, T0 + 2 * DAY + H4] });
    const passed = await verified([entry], rest);
    expect(() => assemblePanel(src, span, passed)).toThrow(/HALT[\s\S]*export[\s\S]*SOLUSDT/);
  });

  it('halts on a null carry input left by a cleared flag, listing it (AMENDMENT 3)', async () => {
    const src = sources();
    src[3].funding = src[3].funding.filter((r) => r.t !== T0 + 2 * DAY);
    const res = await verified([noEvent('SOLUSDT', T0 + 2 * DAY, T0 + 2 * DAY - H8, T0 + 2 * DAY + H8)]);
    expect(() => assemblePanel(src, span, res)).toThrow(/HALT[\s\S]*carry[\s\S]*SOLUSDT 2022-01-02T16:00:00.000Z/);
  });

  it('halts on an entry that matches no flag and on a duplicate entry', async () => {
    const src = sources();
    src[3].funding = grid8(T0 + H4, T0 + 4 * DAY - H8, 4).filter((r) => r.t !== T0 + DAY + H4);
    const good = noEvent('SOLUSDT', T0 + DAY + H4, T0 + DAY, T0 + DAY + H8);
    const unused = noEvent('BTCUSDT', T0 + DAY, T0 + DAY - H8, T0 + DAY + H8);
    const res3 = await verified([good]);
    expect(() => assemblePanel(src, span, res3)).not.toThrow();
    const res4 = await verified([good, unused]);
    expect(() => assemblePanel(src, span, res4)).toThrow(/HALT[\s\S]*matches no flag[\s\S]*BTCUSDT/);
    const res5 = await verified([good, { ...good }]);
    expect(() => assemblePanel(src, span, res5)).toThrow(/HALT[\s\S]*duplicate/i);
  });

  it('refuses resolutions that did not come from verifyResolutions (AMENDMENT 3, review m10)', async () => {
    const forged = { sha256: 'f'.repeat(64), entries: [] } as unknown as VerifiedResolutions;
    expect(() => assemblePanel(sources(), span, forged)).toThrow(/HALT[\s\S]*not verified/);
    const real = await verified();
    expect(() => assemblePanel(sources(), span, { ...real } as VerifiedResolutions)).toThrow(/HALT[\s\S]*not verified/);
    expect(() => resolveFlags([], forged, {})).toThrow(/HALT[\s\S]*not verified/);
    expect(Object.isFrozen(real) && Object.isFrozen(real.entries)).toBe(true);
  });

  it('halts on a cross-check mismatch', async () => {
    const src = sources();
    // Hour 26 sits in 8h bar 3, and raising its high above the bar's high breaks the 1h rebuild only
    src[6].rows1h[26] = { ...src[6].rows1h[26], h: Math.max(...src[6].rows1h.slice(24, 32).map((r) => r.h)) * 1.001 };
    const res6 = await verified();
    expect(() => assemblePanel(src, span, res6)).toThrow(/HALT[\s\S]*cross-check/);
  });

  it('halts when a source symbol list differs from the header universe', async () => {
    const res7 = await verified();
    expect(() => assemblePanel(sources().slice(1), span, res7)).toThrow(/universe/);
  });
});

describe('buildRvPanel (loads the export, verifies the manifest, hashes the panel)', () => {
  let dir: string;
  const BUCKETS = 9;
  const span = { from: T0, to: T0 + 3 * DAY - 1 };

  async function writeExport(target: string): Promise<void> {
    const files: ManifestFile[] = [];
    const put = async (rel: string, kind: ManifestFile['kind'], symbol: string, interval: string, rows: { t: number }[]) => {
      const path = join(target, rel);
      await writeJsonlGz(path, rows);
      files.push({ path: rel, kind, symbol, interval, rowCount: rows.length, startMs: rows[0].t, endMs: rows[rows.length - 1].t, sha256: await sha256File(path) });
    };
    for (const [i, symbol] of RV_SYMBOLS.entries()) {
      const src = sourceFor(symbol, 300 + i, BUCKETS);
      await put(`perp/${symbol}/4h.jsonl.gz`, 'perp', symbol, '4h', src.rows4h);
      await put(`perp/${symbol}/1h.jsonl.gz`, 'perp', symbol, '1h', src.rows1h);
      await put(`funding/${symbol}/settlements.jsonl.gz`, 'funding', symbol, 'settlements', src.funding.filter((r) => r.t <= span.to));
    }
    const manifest: DatasetManifest = {
      version: 1,
      generatedAt: new Date(T0).toISOString(),
      commit: 'fixture',
      lockboxStart: new Date(Date.UTC(2026, 6, 1)).toISOString(),
      symbols: [...RV_SYMBOLS],
      intervals: ['1h', '4h'],
      files,
      datasetHash: datasetHashOf(files),
    };
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rv-panel-'));
    await writeExport(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns the panel with the manifest hash and a sha256 over the canonical panel JSON', async () => {
    const { panel, meta } = await buildRvPanel(dir, span, await verified());
    expect(panel.t).toHaveLength(BUCKETS - 1);
    expect(meta.manifestHash).toBe(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).datasetHash);
    expect(meta.panelSha256).toBe(createHash('sha256').update(stableStringify(panel)).digest('hex'));
    expect(meta.droppedBuckets).toEqual([]);
    expect(meta.resolutions).toEqual({ sha256: 'f'.repeat(64), entries: 0, flags: [] });
    const again = await buildRvPanel(dir, span, await verified());
    expect(again.meta.panelSha256).toBe(meta.panelSha256);
  });

  it('reads lockbox rows (the loaders run with allowLockbox true)', async () => {
    const late = Date.UTC(2026, 6, 1);
    const lateDir = mkdtempSync(join(tmpdir(), 'rv-panel-late-'));
    try {
      const files: ManifestFile[] = [];
      for (const [i, symbol] of RV_SYMBOLS.entries()) {
        const src = sourceFor(symbol, 500 + i, 6, late);
        for (const [rel, kind, interval, rows] of [
          [`perp/${symbol}/4h.jsonl.gz`, 'perp', '4h', src.rows4h],
          [`perp/${symbol}/1h.jsonl.gz`, 'perp', '1h', src.rows1h],
          [`funding/${symbol}/settlements.jsonl.gz`, 'funding', 'settlements', src.funding.filter((r) => r.t <= late + 2 * DAY - 1)],
        ] as const) {
          const path = join(lateDir, rel);
          await writeJsonlGz(path, rows as readonly { t: number }[]);
          files.push({ path: rel, kind, symbol, interval, rowCount: rows.length, startMs: rows[0].t, endMs: rows[rows.length - 1].t, sha256: await sha256File(path) });
        }
      }
      const manifest: DatasetManifest = { version: 1, generatedAt: '', commit: 'fixture', lockboxStart: '', symbols: [...RV_SYMBOLS], intervals: ['1h', '4h'], files, datasetHash: datasetHashOf(files) };
      writeFileSync(join(lateDir, 'manifest.json'), JSON.stringify(manifest));
      const { panel } = await buildRvPanel(lateDir, { from: late, to: late + 2 * DAY - 1 }, await verified());
      expect(panel.t[0]).toBe(late);
      expect(panel.t).toHaveLength(5);
    } finally {
      rmSync(lateDir, { recursive: true, force: true });
    }
  });

  it('halts when a file no longer matches the manifest', async () => {
    writeFileSync(join(dir, 'perp', 'SOLUSDT', '1h.jsonl.gz'), 'tampered');
    await expect(buildRvPanel(dir, span, await verified())).rejects.toThrow(/HALT[\s\S]*sha256[\s\S]*perp\/SOLUSDT\/1h/);
  });

  const rewriteManifest = (edit: (m: DatasetManifest) => void) => {
    const path = join(dir, 'manifest.json');
    const m = JSON.parse(readFileSync(path, 'utf8')) as DatasetManifest;
    edit(m);
    writeFileSync(path, JSON.stringify(m));
  };

  it('halts on a file the panel reads that the manifest does not list (AMENDMENT 2, review I2)', async () => {
    rewriteManifest((m) => {
      m.files = m.files.filter((f) => f.path !== 'perp/SOLUSDT/1h.jsonl.gz');
      m.datasetHash = datasetHashOf(m.files);
    });
    await expect(buildRvPanel(dir, span, await verified())).rejects.toThrow(/HALT[\s\S]*not listed[\s\S]*perp\/SOLUSDT\/1h/);
  });

  it('halts on a listed file whose kind, symbol or interval differs from what the panel reads', async () => {
    for (const patch of [{ kind: 'candles' }, { symbol: 'ETHUSDT' }, { interval: '8h' }] as const) {
      rewriteManifest((m) => {
        m.files = m.files.map((f) => (f.path === 'funding/XRPUSDT/settlements.jsonl.gz' ? { ...f, ...patch } : f));
        m.datasetHash = datasetHashOf(m.files);
      });
      await expect(buildRvPanel(dir, span, await verified()), JSON.stringify(patch)).rejects.toThrow(/HALT[\s\S]*funding\/XRPUSDT/);
      await writeExport(dir);
    }
  });

  it('refuses unverified resolutions before reading anything (AMENDMENT 3)', async () => {
    const forged = { sha256: 'f'.repeat(64), entries: [] } as unknown as VerifiedResolutions;
    await expect(buildRvPanel(dir, span, forged)).rejects.toThrow(/HALT[\s\S]*not verified/);
  });

  it('halts when the manifest\'s dataset hash does not match its own file list', async () => {
    rewriteManifest((m) => {
      m.datasetHash = '0'.repeat(64);
    });
    await expect(buildRvPanel(dir, span, await verified())).rejects.toThrow(/HALT[\s\S]*dataset hash/);
  });
});
