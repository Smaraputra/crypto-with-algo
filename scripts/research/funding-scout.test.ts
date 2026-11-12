// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { FundingCsvRow, KlineCsvRow } from '@/lib/external/binance-archive';

import { CARRY_COST_TAKER, HOUR_MS } from './carry-sim';
import {
  COST_PROFILES,
  detectEpisodes,
  measureEpisode,
  monthsBetween,
  normaliseSettlements,
  parseArgs,
  quantile,
  slotBook,
  summarise,
  SCOUT_CUTOFF_MS,
  SCOUT_FROM_MS,
  SLOT_CAPITAL_PER_UNIT,
  type EpisodeWindow,
  type MeasuredEpisode,
  type ReportEpisodeRow,
  type ScoutSettlement,
} from './funding-scout';

const T0 = Date.UTC(2023, 0, 1, 0);

function bar(open: number, close: number, high = close, low = close): [number, KlineCsvRow] {
  return [
    open,
    { timestamp: open, open: close, high, low, close, volume: 1, quoteVolume: 1, trades: 1, takerBuyVolume: null },
  ];
}

function series(r8s: number[]): ScoutSettlement[] {
  return r8s.map((r8, i) => ({ t: T0 + i * 8 * HOUR_MS, rate: r8, intervalHours: 8, r8 }));
}

describe('monthsBetween', () => {
  it('lists the months touched, inclusive, ascending', () => {
    expect(monthsBetween(Date.UTC(2024, 4, 31, 23), Date.UTC(2024, 5, 30, 23))).toEqual(['2024-05', '2024-06']);
  });
  it('crosses a year boundary', () => {
    expect(monthsBetween(Date.UTC(2022, 11, 31, 23), Date.UTC(2023, 0, 1, 1))).toEqual(['2022-12', '2023-01']);
  });
  it('throws on any month after 2024-06', () => {
    expect(() => monthsBetween(Date.UTC(2024, 5, 30, 23), Date.UTC(2024, 6, 1, 0))).toThrow(/data discipline/);
    expect(() => monthsBetween(Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 2))).toThrow(
      'data discipline: month 2025-01 is after 2024-06'
    );
  });
});

describe('normaliseSettlements', () => {
  const row = (timestamp: number, rate: number, intervalHours: number | null): FundingCsvRow => ({
    timestamp,
    rate,
    intervalHours,
  });

  it('rounds a 1 ms stamp onto the settlement hour', () => {
    const out = normaliseSettlements([row(Date.UTC(2023, 0, 1, 8) + 7, 0.0001, 8)]);
    expect(out).toHaveLength(1);
    expect(out[0].t).toBe(Date.UTC(2023, 0, 1, 8));
  });

  it('keeps the later row of a duplicate', () => {
    const t = Date.UTC(2023, 0, 1, 8);
    const out = normaliseSettlements([row(t + 1, 0.0001, 8), row(t + 2, 0.0003, 8)]);
    expect(out).toHaveLength(1);
    expect(out[0].rate).toBe(0.0003);
  });

  it('infers a null interval from a 4h gap, and scales to an 8h equivalent', () => {
    const t = Date.UTC(2023, 0, 1, 4);
    const out = normaliseSettlements([row(t, 0.0001, 4), row(t + 4 * HOUR_MS, 0.001, null)]);
    expect(out[1].intervalHours).toBe(4);
    expect(out[1].r8).toBeCloseTo(0.002, 12);
  });

  it('falls back to 8 when the gap is not 1, 2, 4 or 8 hours, or there is no predecessor', () => {
    const t = Date.UTC(2023, 0, 1, 0);
    const out = normaliseSettlements([row(t, 0.0001, null), row(t + 3 * HOUR_MS, 0.0001, null)]);
    expect(out.map((o) => o.intervalHours)).toEqual([8, 8]);
  });

  it('drops rows at or after the cutoff and before 2020', () => {
    const out = normaliseSettlements([
      row(Date.UTC(2019, 11, 31, 16), 0.0001, 8),
      row(Date.UTC(2024, 5, 30, 16), 0.0001, 8),
      row(Date.UTC(2024, 6, 1, 0), 0.0001, 8),
      row(Date.UTC(2024, 6, 1, 0) + 1, 0.0001, 8),
    ]);
    expect(out.map((o) => o.t)).toEqual([Date.UTC(2024, 5, 30, 16)]);
  });

  it('sorts ascending', () => {
    const a = Date.UTC(2023, 0, 1, 0);
    const out = normaliseSettlements([row(a + 8 * HOUR_MS, 0.0002, 8), row(a, 0.0001, 8)]);
    expect(out.map((o) => o.rate)).toEqual([0.0001, 0.0002]);
  });
});

describe('detectEpisodes', () => {
  it('positive: finds the closed episode and the truncated tail', () => {
    const eps = detectEpisodes(series([0.0001, 0.0006, 0.0008, 0.0003, 0.0001, 0.0007, 0.0009]), 0.0005, 'positive');
    expect(eps.map((e) => [e.startIdx, e.exitIdx, e.truncated])).toEqual([
      [1, 4, false],
      [5, 6, true],
    ]);
    expect(eps[0].entryT).toBe(T0 + 8 * HOUR_MS);
    expect(eps[0].exitT).toBe(T0 + 32 * HOUR_MS);
    expect(eps[1].exitT).toBe(T0 + 48 * HOUR_MS);
  });

  it('positive: a re-crossing while open does not start a second episode', () => {
    const eps = detectEpisodes(series([0.0001, 0.0006, 0.0003, 0.0007, 0.0001]), 0.0005, 'positive');
    expect(eps.map((e) => [e.startIdx, e.exitIdx, e.truncated])).toEqual([[1, 4, false]]);
  });

  it('positive: an episode that starts on the last settlement is emitted truncated and empty', () => {
    const eps = detectEpisodes(series([0.0001, 0.0006]), 0.0005, 'positive');
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ startIdx: 1, exitIdx: 1, truncated: true });
  });

  it('positive: an episode can start at index 0', () => {
    const eps = detectEpisodes(series([0.0009, 0.0001]), 0.0005, 'positive');
    expect(eps.map((e) => [e.startIdx, e.exitIdx, e.truncated])).toEqual([[0, 1, false]]);
  });

  it('negative: exits when funding is back at zero or above', () => {
    const eps = detectEpisodes(series([0, -0.0006, -0.0002, 0.00001]), 0.0005, 'negative');
    expect(eps.map((e) => [e.startIdx, e.exitIdx, e.truncated])).toEqual([[1, 3, false]]);
  });
});

describe('measureEpisode', () => {
  // Settlements at T0 (rate irrelevant), T0+8h (0.001), T0+16h (0.002).
  const settlements: ScoutSettlement[] = [
    { t: T0, rate: 0.0007, intervalHours: 8, r8: 0.0007 },
    { t: T0 + 8 * HOUR_MS, rate: 0.001, intervalHours: 8, r8: 0.001 },
    { t: T0 + 16 * HOUR_MS, rate: 0.002, intervalHours: 8, r8: 0.002 },
  ];
  const ep: EpisodeWindow = {
    side: 'positive',
    level: 0.0005,
    startIdx: 0,
    exitIdx: 2,
    entryT: T0,
    exitT: T0 + 16 * HOUR_MS,
    truncated: false,
  };

  function maps(perpEntry = 100, spotLevel = 100, perpLater = 101) {
    const perp = new Map<number, KlineCsvRow>();
    const spot = new Map<number, KlineCsvRow>();
    // Required opens: T0 - 1h .. T0 + 15h (17 bars).
    for (let k = 0; k <= 16; k++) {
      const open = T0 - HOUR_MS + k * HOUR_MS;
      const [, p] = bar(open, k === 0 ? perpEntry : perpLater, k === 5 ? 105 : undefined);
      perp.set(open, p);
      spot.set(open, bar(open, spotLevel)[1]);
    }
    return { perp, spot };
  }

  it('positive carry, hand computed', () => {
    const { perp, spot } = maps();
    const m = measureEpisode(ep, settlements, perp, spot);
    expect(m.status).toBe('ok');
    expect(m.grossFunding).toBeCloseTo(0.003, 12);
    expect(m.basis).toBeCloseTo(-0.01, 12);
    expect(m.net![CARRY_COST_TAKER.name]).toBeCloseTo(0.003 - 0.01 - 2 * CARRY_COST_TAKER.perSide, 12);
    for (const profile of COST_PROFILES) {
      expect(m.net![profile.name]).toBeCloseTo(0.003 - 0.01 - 2 * profile.perSide, 12);
    }
    expect(m.maxAdverse).toBeCloseTo(0.05, 12);
    expect(m.liquidated).toEqual({ '2x': false, '3x': false });
    expect(m.holdHours).toBe(16);
    expect(m.settlementsCollected).toBe(2);
    expect(m.premiumEntry).toBeCloseTo(0, 12);
    expect(m.premiumExit).toBeCloseTo(0.01, 12);
    expect(m.multiplier).toBe(1);
  });

  it('flags liquidation at 3x but not 2x for a 40% adverse move', () => {
    const { perp, spot } = maps();
    perp.set(T0 + 3 * HOUR_MS, bar(T0 + 3 * HOUR_MS, 101, 140)[1]);
    const m = measureEpisode(ep, settlements, perp, spot);
    expect(m.maxAdverse).toBeCloseTo(0.4, 12);
    // 1/3 - 0.005 = 0.328 <= 0.4 ; 1/2 - 0.005 = 0.495 > 0.4
    expect(m.liquidated).toEqual({ '2x': false, '3x': true });
  });

  it('negative side flips the sign and measures the adverse move on the low', () => {
    const { perp, spot } = maps();
    perp.set(T0 + 3 * HOUR_MS, bar(T0 + 3 * HOUR_MS, 101, 101, 60)[1]);
    const m = measureEpisode({ ...ep, side: 'negative' }, settlements, perp, spot);
    expect(m.grossFunding).toBeCloseTo(-0.003, 12);
    expect(m.basis).toBeCloseTo(0.01, 12);
    expect(m.maxAdverse).toBeCloseTo(0.4, 12);
  });

  it('a missing required perp bar is a gap', () => {
    const { perp, spot } = maps();
    perp.delete(T0 + 5 * HOUR_MS);
    const m = measureEpisode(ep, settlements, perp, spot);
    expect(m.status).toBe('gap');
    expect(m.missingBars).toBe(1);
    expect(m.net).toBeNull();
  });

  it('no spot map is no-spot', () => {
    const { perp } = maps();
    expect(measureEpisode(ep, settlements, perp, null).status).toBe('no-spot');
  });

  it('exitT not after entryT is empty', () => {
    const { perp, spot } = maps();
    expect(measureEpisode({ ...ep, exitIdx: 0, exitT: T0 }, settlements, perp, spot).status).toBe('empty');
  });

  it('detects a 1000x multiplier and a zero premium', () => {
    const { perp, spot } = maps(1_000_000, 1_000, 1_000_000);
    const m = measureEpisode(ep, settlements, perp, spot);
    expect(m.multiplier).toBe(1000);
    expect(m.premiumEntry).toBeCloseTo(0, 12);
  });
});

describe('quantile', () => {
  it('interpolates linearly', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12);
    expect(quantile([1, 2, 3, 4], 0.1)).toBeCloseTo(1.3, 12);
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 12);
    expect(quantile([5], 0.9)).toBe(5);
  });
  it('is null on an empty set', () => {
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('summarise', () => {
  const okEpisode = (symbol: string, entryT: number, taker: number, hold: number, liq3: boolean): MeasuredEpisode => ({
    symbol,
    side: 'positive',
    level: 0.0005,
    startIdx: 0,
    exitIdx: 1,
    entryT,
    exitT: entryT + hold * HOUR_MS,
    truncated: false,
    status: 'ok',
    missingBars: 0,
    grossFunding: taker + 0.01,
    basis: 0,
    multiplier: 1,
    premiumEntry: 0,
    premiumExit: 0,
    maxAdverse: 0.01,
    liquidated: { '2x': false, '3x': liq3 },
    holdHours: hold,
    settlementsCollected: hold / 8,
    net: Object.fromEntries(COST_PROFILES.map((p) => [p.name, p.name === CARRY_COST_TAKER.name ? taker : taker - 1])),
  });

  const episodes: MeasuredEpisode[] = [
    okEpisode('AAAUSDT', Date.UTC(2022, 5, 1), 0.01, 8, false),
    okEpisode('AAAUSDT', Date.UTC(2022, 8, 1), -0.02, 16, true),
    okEpisode('BBBUSDT', Date.UTC(2023, 2, 1), 0.05, 24, false),
    {
      ...okEpisode('CCCUSDT', Date.UTC(2023, 3, 1), 9, 8, false),
      truncated: true,
    },
  ];

  it('counts, medians, shares and the year split', () => {
    const s = summarise(0.0005, 'positive', episodes);
    expect(s.counts).toEqual({ total: 4, ok: 3, noSpot: 0, gap: 0, empty: 0, truncated: 1 });
    expect(s.distinctSymbols).toBe(2);
    const taker = s.net[CARRY_COST_TAKER.name];
    expect(taker.median).toBeCloseTo(0.01, 12);
    expect(taker.mean).toBeCloseTo((0.01 - 0.02 + 0.05) / 3, 12);
    expect(taker.shareNetPositive).toBeCloseTo(2 / 3, 12);
    expect(taker.p10).toBeCloseTo(-0.02 + 0.2 * 0.03, 12);
    expect(taker.p90).toBeCloseTo(0.01 + 0.8 * 0.04, 12);
    expect(s.holdHours.median).toBe(16);
    expect(s.settlementsMedian).toBe(2);
    expect(s.liquidationShare['3x']).toBeCloseTo(1 / 3, 12);
    expect(s.liquidationShare['2x']).toBe(0);
    // Only three ok episodes, so the top 10 is all of them.
    expect(s.top10Share).toBeCloseTo(1, 12);
    expect(s.byYear['2022'].n).toBe(2);
    expect(s.byYear['2022'].sumNetTaker).toBeCloseTo(-0.01, 12);
    expect(s.byYear['2022'].meanNetTaker).toBeCloseTo(-0.005, 12);
    expect(s.byYear['2023'].n).toBe(1);
    expect(s.byYear['2023'].meanNetTaker).toBeCloseTo(0.05, 12);
  });

  it('top10Share compares the 10 largest nets against the total', () => {
    const many = Array.from({ length: 12 }, (_, i) => okEpisode(`S${i}USDT`, Date.UTC(2022, 0, 1 + i), 0.01, 8, false));
    const s = summarise(0.0005, 'positive', many);
    // 12 equal nets: top 10 of 12 is 10/12 of the total.
    expect(s.top10Share).toBeCloseTo(10 / 12, 12);
  });

  it('top10Share is null when the total is not positive, and empty sets give nulls', () => {
    expect(summarise(0.0005, 'positive', [okEpisode('A', Date.UTC(2022, 0, 1), -0.01, 8, false)]).top10Share).toBeNull();
    const empty = summarise(0.0005, 'positive', []);
    expect(empty.counts.total).toBe(0);
    expect(empty.net[CARRY_COST_TAKER.name].median).toBeNull();
    expect(empty.net[CARRY_COST_TAKER.name].shareNetPositive).toBeNull();
    expect(empty.liquidationShare['3x']).toBeNull();
    expect(empty.top10Share).toBeNull();
  });
});

describe('parseArgs', () => {
  it('requires the three paths and defaults concurrency to 4', () => {
    expect(() => parseArgs(['--universe', 'u.json'])).toThrow(/--cache is required/);
    const args = parseArgs(['--universe', 'u.json', '--cache', 'c', '--out', 'o.json']);
    expect(args).toMatchObject({ concurrency: 4, symbols: null });
  });
  it('splits --symbols and rejects unknown flags', () => {
    const args = parseArgs(['--universe', 'u', '--cache', 'c', '--out', 'o', '--symbols', 'A, B', '--concurrency', '2']);
    expect(args.symbols).toEqual(['A', 'B']);
    expect(args.concurrency).toBe(2);
    expect(() => parseArgs(['--to', '2025-01'])).toThrow(/Unknown flag --to/);
  });
  it('accepts --analyse alone and rejects it beside any other flag', () => {
    expect(parseArgs(['--analyse', 'r.json']).analyse).toBe('r.json');
    expect(() => parseArgs(['--analyse', 'r.json', '--out', 'x'])).toThrow(/--analyse/);
  });
});

describe('slotBook', () => {
  const D = 24 * HOUR_MS;
  const Y22 = Date.UTC(2022, 5, 1);
  const Y23 = Date.UTC(2023, 5, 1);
  const spanMs = SCOUT_CUTOFF_MS - SCOUT_FROM_MS;
  const years = spanMs / (365 * 24 * HOUR_MS);

  function row(symbol: string, entryT: number, exitT: number, over: Partial<ReportEpisodeRow> = {}): ReportEpisodeRow {
    return {
      symbol,
      side: 'positive',
      level: 0.001,
      entryT,
      exitT,
      status: 'ok',
      truncated: false,
      netTaker: 0.01,
      maxAdverse: 0.1,
      ...over,
    };
  }

  it('takes first come first served into 2 slots and skips the row that finds none free', () => {
    const rows = [
      row('E', Y23 + 5 * D, Y23 + 6 * D, { netTaker: 0.05 }),
      row('A', Y22, Y22 + 10 * D, { netTaker: 0.02 }),
      row('B', Y22 + D, Y22 + 3 * D, { netTaker: 0.01 }),
      row('C', Y22 + 2 * D, Y22 + 4 * D, { netTaker: 0.04 }), // both slots busy: skipped
      row('D', Y22 + 3 * D, Y22 + 5 * D, { netTaker: 0.03 }),
    ];
    const r = slotBook(rows, 'positive', 0.001, 2);
    expect(r.eligible).toBe(5);
    expect(r.taken).toBe(4);
    expect(r.totalNetTaker).toBeCloseTo(0.02 + 0.01 + 0.03 + 0.05, 12);
    expect(r.annualReturnOnCapital).toBeCloseTo(0.11 / (2 * SLOT_CAPITAL_PER_UNIT) / years, 12);
    expect(r.slotUse).toBeCloseTo((10 * D + 2 * D + 2 * D + 1 * D) / (2 * spanMs), 12);
    expect(Object.keys(r.byYear).sort()).toEqual(['2022', '2023']);
    expect(r.byYear['2022'].n).toBe(3);
    expect(r.byYear['2022'].sumNetTaker).toBeCloseTo(0.06, 12);
    expect(r.byYear['2022'].returnOnCapital).toBeCloseTo(0.06 / 4, 12);
    expect(r.byYear['2023'].n).toBe(1);
    expect(r.byYear['2023'].returnOnCapital).toBeCloseTo(0.05 / 4, 12);
  });

  it('excludes gap, truncated, other-level, other-side and null-net rows', () => {
    const rows = [
      row('A', Y22, Y22 + D),
      row('B', Y22, Y22 + D, { status: 'gap' }),
      row('C', Y22, Y22 + D, { truncated: true }),
      row('D', Y22, Y22 + D, { level: 0.002 }),
      row('E', Y22, Y22 + D, { side: 'negative' }),
      row('F', Y22, Y22 + D, { netTaker: null }),
    ];
    const r = slotBook(rows, 'positive', 0.001, 5);
    expect(r.eligible).toBe(1);
    expect(r.taken).toBe(1);
  });

  it('counts a 1x perp liquidation at maxAdverse 0.995 but not 0.99', () => {
    const rows = [
      row('A', Y22, Y22 + D, { maxAdverse: 0.995 }),
      row('B', Y22 + 2 * D, Y22 + 3 * D, { maxAdverse: 0.99 }),
      row('C', Y22 + 4 * D, Y22 + 5 * D, { maxAdverse: null }),
    ];
    expect(slotBook(rows, 'positive', 0.001, 5).perpLiquidations1x).toBe(1);
  });

  it('breaks entryT ties by symbol order', () => {
    const rows = [
      row('ZZZ', Y22, Y22 + D, { netTaker: 0.5 }),
      row('AAA', Y22, Y22 + D, { netTaker: 0.1 }),
    ];
    const r = slotBook(rows, 'positive', 0.001, 1);
    expect(r.taken).toBe(1);
    expect(r.totalNetTaker).toBeCloseTo(0.1, 12);
  });
});
