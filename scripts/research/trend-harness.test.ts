import { describe, expect, it } from 'vitest';
import type { CandleRow, FundingRow, PerpCandleRow, SnapshotRow } from './dataset-format';
import { DAY_MS } from './trend-signals';
import {
  CONSISTENCY_FROM,
  buildSettlements,
  c3PathsFor,
  dailyInput,
  formatTrend,
  listingDayOf,
  parseArgs,
  runTrendStudy,
  splicedInput,
  type TrendInputs,
} from './trend-harness';
import { validateTrendReport } from './report-schema';
import type { TrendSymbolInput } from './trend-sim';

function snapshot(t: number, rate: number | null): SnapshotRow {
  return {
    t,
    fundingRate: rate === null ? null : { rate, markPrice: null },
    longShortRatio: null,
    openInterest: null,
    fearGreed: null,
    newsSentiment: null,
  } as unknown as SnapshotRow;
}

describe('parseArgs', () => {
  it('requires a known rule and defaults the rest', () => {
    const args = parseArgs(['--rule', 'TF4', '--dataset-dir', '/ds']);
    expect(args.rule).toBe('TF4');
    expect(args.datasetDir).toBe('/ds');
    expect(args.draws).toBe(200);
    expect(args.symbols).toHaveLength(10);
    expect(args.out).toBe('data/research/reports/trend-tf4.json');
    expect(() => parseArgs(['--rule', 'TF9'])).toThrow(/--rule/);
    expect(() => parseArgs(['--rule', 'TF1', '--bogus', 'x'])).toThrow(/Unknown flag/);
    expect(() => parseArgs(['--rule', 'TF1', '--draws', '0'])).toThrow(/draws/);
  });
});

describe('listing and funding', () => {
  it('the listing is the first 1d snapshot carrying a funding rate', () => {
    const rows = [snapshot(Date.UTC(2019, 8, 10), null), snapshot(Date.UTC(2019, 8, 11), 0.0001)];
    expect(listingDayOf('BTCUSDT', rows)).toBe(Date.UTC(2019, 8, 11));
    expect(() => listingDayOf('X', [snapshot(0, null)])).toThrow(/no 1d snapshot/);
  });

  it('fills 8h boundaries from the listing to the first archived settlement at the last 4h snapshot rate', () => {
    const listing = Date.UTC(2019, 11, 31);
    const archive: FundingRow[] = [
      { t: Date.UTC(2020, 0, 1, 8), rate: 0.0003, intervalHours: 8 },
      { t: Date.UTC(2020, 0, 1, 0), rate: 0.0002, intervalHours: 8 },
    ];
    const snaps = [snapshot(Date.UTC(2019, 11, 30, 20), 0.0001), snapshot(Date.UTC(2019, 11, 31, 8), 0.0005)];
    const { settlements, fallback } = buildSettlements(listing, archive, snaps);
    // 00:00, 08:00 and 16:00 on the 31st, then the archive (sorted).
    expect(fallback).toBe(3);
    expect(settlements.map((s) => s.rate)).toEqual([0.0001, 0.0005, 0.0005, 0.0002, 0.0003]);
    expect(settlements[3].t).toBe(Date.UTC(2020, 0, 1, 0));
  });

  it('adds no fallback when the archive starts at or before the listing', () => {
    const archive: FundingRow[] = [{ t: Date.UTC(2020, 8, 22, 8), rate: 0.0001, intervalHours: 8 }];
    expect(buildSettlements(Date.UTC(2020, 8, 23), archive, []).fallback).toBe(0);
  });
});

describe('splicedInput', () => {
  it('takes spot bars before the splice and perp bars from it', () => {
    const day = (i: number) => CONSISTENCY_FROM + (i - 2) * DAY_MS;
    const spot: CandleRow[] = [0, 1, 2, 3].map((i) => ({ t: day(i), o: 10 + i, h: 0, l: 0, c: 10 + i, v: 0, tbv: null }));
    const perp: PerpCandleRow[] = [2, 3].map((i) => ({ t: day(i), o: 20 + i, h: 0, l: 0, c: 20 + i, v: 0, qv: 0, n: 0, tbv: null }));
    const { input, filled } = splicedInput('A', spot, perp, CONSISTENCY_FROM, day(0), []);
    expect(filled).toBe(0);
    expect(input.close).toEqual([10, 11, 22, 23]);
    expect(input.open).toEqual([10, 11, 22, 23]);
    expect(input.t).toEqual([day(0), day(1), day(2), day(3)]);
  });

  it('fills a missing day by carrying the last close, open and close alike', () => {
    const day = (i: number) => CONSISTENCY_FROM + i * DAY_MS;
    const rows = [0, 1, 4].map((i) => ({ t: day(i), o: 10 + i, c: 11 + i }));
    const { input, filled } = dailyInput('A', rows, day(0), []);
    expect(filled).toBe(2);
    expect(input.t).toEqual([0, 1, 2, 3, 4].map(day));
    expect(input.open).toEqual([10, 11, 12, 12, 14]);
    expect(input.close).toEqual([11, 12, 12, 12, 15]);
  });
});

describe('c3PathsFor', () => {
  it('chain-links the equal-weight basket and maps the shared state onto each symbol', () => {
    const start = Date.UTC(2020, 0, 1);
    const n = 400;
    const mk = (symbol: string, from: number, r: number): TrendSymbolInput => {
      const t = Array.from({ length: n - from }, (_, i) => start + (from + i) * DAY_MS);
      const close = t.map((_, i) => 100 * (1 + r) ** i * (1 + 0.01 * Math.sin(i / 3)));
      return { symbol, t, open: close, close, listingDay: t[0], settlements: [] };
    };
    const a = mk('A', 0, 0.002);
    const b = mk('B', 50, -0.001);
    const p = c3PathsFor([a, b]);
    // B's bars are A's last 350: the same basket state on the same days.
    for (let i = 0; i < 350; i++) expect(p.B.signal[i]).toBe(p.A.signal[i + 50]);
    expect(p.A.rebalance).toEqual({ kind: 'on-signal-change' });
    expect(Array.from(p.A.signal).some((x) => x === 1)).toBe(true);
  });
});

/** A seeded random walk of daily bars. */
function walk(seed: number, from: number, to: number, scale = 1): CandleRow[] {
  let s = seed;
  const rows: CandleRow[] = [];
  let c = 100 * scale;
  for (let t = from; t < to; t += DAY_MS) {
    s = (s * 16807) % 2147483647;
    const o = c;
    c = c * (1 + (s / 2147483647 - 0.49) * 0.06);
    rows.push({ t, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1, tbv: null });
  }
  return rows;
}

function syntheticInputs(): TrendInputs {
  const from = Date.UTC(2018, 10, 1);
  const to = Date.UTC(2026, 6, 1);
  const listings = [Date.UTC(2019, 8, 11), Date.UTC(2019, 10, 28), Date.UTC(2020, 8, 23)];
  const primary: TrendSymbolInput[] = [];
  const perp: TrendSymbolInput[] = [];
  const fallback: Record<string, number> = {};
  const filledDays: Record<string, { primary: number; perp: number }> = {};
  listings.forEach((listing, k) => {
    const symbol = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'][k];
    const spot = walk(11 + k, from, to);
    const perpRows: PerpCandleRow[] = spot
      .filter((r) => r.t >= CONSISTENCY_FROM)
      .map((r) => ({ ...r, o: r.o * 1.0005, c: r.c * 1.0005, qv: 0, n: 0 }));
    const archive: FundingRow[] = [];
    for (let t = Date.UTC(2020, 0, 1); t < to; t += 8 * 3_600_000) archive.push({ t, rate: 0.0001, intervalHours: 8 });
    const snaps = [snapshot(Date.UTC(2019, 8, 10, 8), 0.0001)];
    const { settlements, fallback: count } = buildSettlements(listing, archive, snaps);
    fallback[symbol] = count;
    primary.push(splicedInput(symbol, spot, [], to, listing, settlements).input);
    perp.push(splicedInput(symbol, spot, perpRows, CONSISTENCY_FROM, listing, settlements).input);
    filledDays[symbol] = { primary: 0, perp: 0 };
  });
  return { primary, perp, fallback, filledDays, lockboxApplied: true };
}

describe('runTrendStudy', () => {
  const inputs = syntheticInputs();
  const symbols = inputs.primary.map((i) => i.symbol);

  it.each(['TF3', 'C3'] as const)('%s produces a schema-valid report with every gate and the daily series', (rule) => {
    const report = runTrendStudy(
      { rule, datasetDir: '/unused', symbols, out: '/unused', taskId: 't', draws: 3 },
      inputs,
      'hash'
    );
    expect(validateTrendReport(report).ok).toBe(true);
    expect(report.gates.map((g) => g.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(report.sample.firstDay).toBe(Date.UTC(2019, 8, 11));
    expect(report.sample.lastDay).toBe(Date.UTC(2026, 5, 30));
    expect(report.daily.returns).toHaveLength(report.sample.days);
    expect(report.startDays).toEqual({
      AAAUSDT: Date.UTC(2019, 8, 11),
      BBBUSDT: Date.UTC(2019, 10, 28),
      CCCUSDT: Date.UTC(2020, 8, 23),
    });
    expect(Object.keys(report.dropOne)).toEqual(symbols);
    expect(report.timing.draws).toBe(3);
    expect(report.consistency.days).toBe((Date.UTC(2026, 6, 1) - CONSISTENCY_FROM) / DAY_MS);
    // The always-long twin of TF3 and C3 is buy-and-hold: no short leg, gross near 1.
    expect(report.twin.shortLegAnnual).toBe(0);
    expect(report.twin.gross.p50).toBeGreaterThan(0.95);
    expect(report.fallbackSettlements.AAAUSDT).toBeGreaterThan(0);
    expect(formatTrend(report)).toContain(`VERDICT ${report.verdict}`);
  });
});
