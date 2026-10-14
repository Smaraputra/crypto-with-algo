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
  checkFunding,
  crossCheck1h,
  fundingPerBar,
  pairTo8h,
  panelGrid,
  type RvSymbolSource,
} from './rv-panel';

const H = 3_600_000;
const H4 = 4 * H;
const H8 = 8 * H;
const DAY = 24 * H;
const T0 = Date.UTC(2022, 0, 1);

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

describe('checkFunding (header DATA: HALT on any missing due settlement)', () => {
  const window = { from: T0, to: T0 + 6 * DAY };

  it('passes a complete 8h grid with stated intervals', () => {
    expect(() => checkFunding('X', grid8(T0 + H8, T0 + 6 * DAY), window)).not.toThrow();
  });

  it('halts on a missing settlement inside the window, at its head and at its tail', () => {
    const full = grid8(T0 + H8, T0 + 6 * DAY);
    expect(() => checkFunding('X', full.filter((r) => r.t !== T0 + 2 * DAY + H8), window)).toThrow(/missing[\s\S]*X/);
    expect(() => checkFunding('X', full.filter((r) => r.t !== T0 + H8), window)).toThrow(/missing/);
    expect(() => checkFunding('X', full.filter((r) => r.t !== T0 + 6 * DAY), window)).toThrow(/missing/);
  });

  it('does not require a settlement at the window open or after the window close', () => {
    const rows = [{ t: T0, rate: 0.0001, intervalHours: 8 }, ...grid8(T0 + H8, T0 + 6 * DAY)];
    expect(() => checkFunding('X', rows, window)).not.toThrow();
    expect(() => checkFunding('X', grid8(T0 + H8, T0 + 6 * DAY), { from: T0, to: T0 + 6 * DAY - 16 * H })).not.toThrow();
  });

  it('reads stated intervals: an 8h-to-4h switch is complete and a missing 4h settlement halts', () => {
    const switched = [...grid8(T0 + H8, T0 + 3 * DAY), ...grid8(T0 + 3 * DAY + H4, T0 + 6 * DAY, 4)];
    expect(() => checkFunding('X', switched, window)).not.toThrow();
    expect(() => checkFunding('X', switched.filter((r) => r.t !== T0 + 4 * DAY + 12 * H), window)).toThrow(/missing/);
  });

  it('derives the interval from the spacing when intervalHours is null (REST rows)', () => {
    const nul = (rows: FundingRow[]) => rows.map((r) => ({ ...r, intervalHours: null }));
    const eight = nul(grid8(T0 + H8, T0 + 6 * DAY));
    expect(() => checkFunding('X', eight, window)).not.toThrow();
    expect(() => checkFunding('X', eight.filter((r) => r.t !== T0 + 2 * DAY + H8), window)).toThrow(/missing/);
    expect(() => checkFunding('X', eight.filter((r) => r.t !== T0 + 2 * DAY + H8 && r.t !== T0 + 2 * DAY + 2 * H8), window)).toThrow(/missing/);

    const shortened = nul([...grid8(T0 + H8, T0 + 3 * DAY), ...grid8(T0 + 3 * DAY + H4, T0 + 6 * DAY, 4)]);
    expect(() => checkFunding('X', shortened, window)).not.toThrow();
    const lengthened = nul([...grid8(T0 + H4, T0 + 3 * DAY, 4), ...grid8(T0 + 3 * DAY + H8, T0 + 6 * DAY)]);
    expect(() => checkFunding('X', lengthened, window)).not.toThrow();
    // One missing 4h settlement leaves a lone 8h gap between 4h gaps
    expect(() => checkFunding('X', shortened.filter((r) => r.t !== T0 + 4 * DAY + 12 * H), window)).toThrow(/missing/);
  });

  it('halts when the interval cannot be derived, on a duplicate settlement, and on a time off the hour', () => {
    expect(() => checkFunding('X', [{ t: T0 + H8, rate: 0.0001, intervalHours: null }], { from: T0, to: T0 + H8 })).toThrow(/interval/);
    const rows = grid8(T0 + H8, T0 + 6 * DAY);
    expect(() => checkFunding('X', [...rows, rows[3]], window)).toThrow(/duplicate/i);
    expect(() => checkFunding('X', [...rows.slice(0, 3), { ...rows[3], t: rows[3].t + 1 }, ...rows.slice(4)], window)).toThrow(/hour/);
  });

  it('halts when no settlement exists at all', () => {
    expect(() => checkFunding('X', [], window)).toThrow(/no settlement/i);
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

  it('reports any OHLC difference exactly, and volume or taker-buy volume beyond a relative 1e-7', () => {
    const src = sourceFor('A', 12, 6);
    const panel = panelOf(src, 6);
    const r1 = src.rows1h.map((r) => ({ ...r }));
    r1[8].h = Math.max(...r1.slice(8, 16).map((r) => r.h)) * 1.000001; // bar 1's high, raised
    r1[20].v = r1[20].v + panel.volume[0][2] * 2e-7;
    r1[33].tbv = (r1[33].tbv as number) + panel.tbv[0][4] * 5e-8; // inside the tolerance
    const mm = crossCheck1h(panel, { A: r1 });
    expect(mm.map((m) => [m.t, m.field])).toEqual([
      [T0 + H8, 'high'],
      [T0 + 2 * H8, 'volume'],
    ]);
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

describe('assemblePanel (header DATA halts)', () => {
  const BUCKETS = 12;
  const span = { from: T0, to: T0 + 4 * DAY - 1 };
  const sources = () => RV_SYMBOLS.map((s, i) => sourceFor(s, 100 + i, BUCKETS));

  it('builds a rectangular panel over the grid, the final 16:00 bar left out', () => {
    const { panel, droppedBuckets } = assemblePanel(sources(), span);
    expect(panel.symbols).toEqual([...RV_SYMBOLS]);
    expect(panel.t).toHaveLength(BUCKETS - 1);
    expect(panel.t[panel.t.length - 1]).toBe(T0 + 4 * DAY - 2 * H8);
    expect(droppedBuckets).toEqual([]);
    for (const col of [panel.open, panel.high, panel.low, panel.close, panel.volume, panel.tbv, panel.fundSum, panel.fundLast]) {
      expect(col).toHaveLength(RV_SYMBOLS.length);
      for (const row of col) expect(row).toHaveLength(BUCKETS - 1);
    }
    expect(panel.fundLast.flat().every((v) => v !== null)).toBe(true);
  });

  it('counts dropped buckets across the panel and halts above 3', () => {
    const three = sources();
    three[1].rows4h = three[1].rows4h.filter((r) => r.t !== T0 + H8 + H4);
    three[2].rows4h = three[2].rows4h.filter((r) => r.t !== T0 + 2 * H8 && r.t !== T0 + 5 * H8);
    const ok = assemblePanel(three, span);
    expect(ok.droppedBuckets.map((d) => [d.symbol, d.t])).toEqual([
      [RV_SYMBOLS[1], T0 + H8],
      [RV_SYMBOLS[2], T0 + 2 * H8],
      [RV_SYMBOLS[2], T0 + 5 * H8],
    ]);
    expect(ok.panel.t).not.toContain(T0 + H8);
    expect(ok.panel.t).toHaveLength(BUCKETS - 1 - 3);

    const four = sources();
    four[1].rows4h = four[1].rows4h.filter((r) => r.t !== T0 + H8 + H4);
    four[2].rows4h = four[2].rows4h.filter((r) => r.t !== T0 + 2 * H8 && r.t !== T0 + 5 * H8);
    four[9].rows4h = four[9].rows4h.filter((r) => r.t !== T0 + 7 * H8);
    expect(() => assemblePanel(four, span)).toThrow(/HALT[\s\S]*4 buckets dropped/);
  });

  it('halts on a null taker-buy volume', () => {
    const src = sources();
    src[4].rows4h[5] = { ...src[4].rows4h[5], tbv: null };
    expect(() => assemblePanel(src, span)).toThrow(/HALT[\s\S]*taker-buy/);
  });

  it('halts on a missing settlement', () => {
    const src = sources();
    src[3].funding = src[3].funding.filter((r) => r.t !== T0 + 2 * DAY);
    expect(() => assemblePanel(src, span)).toThrow(/HALT[\s\S]*missing/);
  });

  it('halts on a cross-check mismatch', () => {
    const src = sources();
    // Hour 26 sits in 8h bar 3, and raising its high above the bar's high breaks the 1h rebuild only
    src[6].rows1h[26] = { ...src[6].rows1h[26], h: Math.max(...src[6].rows1h.slice(24, 32).map((r) => r.h)) * 1.001 };
    expect(() => assemblePanel(src, span)).toThrow(/HALT[\s\S]*cross-check/);
  });

  it('halts when a source symbol list differs from the header universe', () => {
    expect(() => assemblePanel(sources().slice(1), span)).toThrow(/universe/);
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
    const { panel, meta } = await buildRvPanel(dir, span);
    expect(panel.t).toHaveLength(BUCKETS - 1);
    expect(meta.manifestHash).toBe(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).datasetHash);
    expect(meta.panelSha256).toBe(createHash('sha256').update(stableStringify(panel)).digest('hex'));
    expect(meta.droppedBuckets).toEqual([]);
    const again = await buildRvPanel(dir, span);
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
      const { panel } = await buildRvPanel(lateDir, { from: late, to: late + 2 * DAY - 1 });
      expect(panel.t[0]).toBe(late);
      expect(panel.t).toHaveLength(5);
    } finally {
      rmSync(lateDir, { recursive: true, force: true });
    }
  });

  it('halts when a file no longer matches the manifest', async () => {
    writeFileSync(join(dir, 'perp', 'SOLUSDT', '1h.jsonl.gz'), 'tampered');
    await expect(buildRvPanel(dir, span)).rejects.toThrow(/HALT[\s\S]*manifest/);
  });
});
