// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  BROAD_GATED_YEARS,
  BROAD_MIN_SAMPLE_DAYS,
  BROAD_PHASE_TRIALS,
  BROAD_PROGRAM_TRIALS,
  BTC_ETH_ASSETS,
  LEGENDS_TEN_ASSETS,
  broadVerdict,
  contractsOfAssets,
  evaluateBroadGates,
  firstDefinedMemberDay,
  listingYearCohorts,
  rejectionRates,
  topContributors,
  windowAlpha,
  yearAlphaBetas,
  type BroadGateInputs,
} from './broad-gates';
import { DAY_MS, type RulePaths } from './trend-signals';
import { annualAlpha, type TrendSymbolInput } from './trend-sim';

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

describe('constants', () => {
  it('are the header\'s', () => {
    expect(BROAD_MIN_SAMPLE_DAYS).toBe(1825);
    expect([BROAD_PHASE_TRIALS, BROAD_PROGRAM_TRIALS]).toEqual([16, 1729]);
    expect([...BROAD_GATED_YEARS]).toEqual([2021, 2022, 2023, 2024, 2025]);
    expect([...LEGENDS_TEN_ASSETS]).toEqual(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'LINK']);
    expect([...BTC_ETH_ASSETS]).toEqual(['BTC', 'ETH']);
  });
});

describe('listingYearCohorts (gate 5 merge rule)', () => {
  const c = (id: string, listingYear: number, memberDays: number) => ({ id, listingYear, memberDays });

  it('keeps every cohort at or above 10% of member-days, exactly 10% included', () => {
    const cohorts = listingYearCohorts([c('A', 2020, 60), c('B', 2021, 30), c('C', 2022, 10)]);
    expect(cohorts.map((x) => x.label)).toEqual(['2020', '2021', '2022']);
    expect(cohorts.map((x) => x.share)).toEqual([0.6, 0.3, 0.1]);
  });

  it('merges a cohort under 10% into the next older one', () => {
    const cohorts = listingYearCohorts([c('A', 2020, 50), c('B', 2021, 41), c('C', 2023, 9), c('D', 2023, 0)]);
    expect(cohorts.map((x) => [x.label, x.memberDays])).toEqual([
      ['2020', 50],
      ['2021+2023', 50],
    ]);
    expect(cohorts[1].contracts).toEqual(['B', 'C', 'D']);
    expect(cohorts[1].years).toEqual([2021, 2023]);
  });

  it('merges the oldest cohort, when under 10%, into the next younger one', () => {
    const cohorts = listingYearCohorts([c('A', 2019, 5), c('B', 2020, 45), c('C', 2021, 50)]);
    expect(cohorts.map((x) => x.label)).toEqual(['2019+2020', '2021']);
    expect(cohorts[0].memberDays).toBe(50);
  });

  it('merges again while a merged cohort stays under 10%, youngest first', () => {
    // 2025 (1%) joins 2024 (3%): 4%, still under, joins 2023 (6%): 10%, kept.
    const cohorts = listingYearCohorts([
      c('A', 2020, 50),
      c('B', 2021, 25),
      c('C', 2022, 15),
      c('D', 2023, 6),
      c('E', 2024, 3),
      c('F', 2025, 1),
    ]);
    expect(cohorts.map((x) => x.label)).toEqual(['2020', '2021', '2022', '2023+2024+2025']);
    expect(cohorts[3].memberDays).toBe(10);
    expect(cohorts[3].contracts).toEqual(['D', 'E', 'F']);
  });

  it('leaves a single cohort alone and reports null shares without member-days', () => {
    expect(listingYearCohorts([c('A', 2020, 1)]).map((x) => x.label)).toEqual(['2020']);
    const empty = listingYearCohorts([c('A', 2020, 0), c('B', 2021, 0)]);
    expect(empty.map((x) => x.share)).toEqual([null, null]);
  });
});

describe('topContributors (gate 5 drop-top-5)', () => {
  const t = { A: [1, 1, 1, 9], B: [0, 2, 2, 0], C: [0, 0, 0, 0], D: [5, 0, 0, 0], E: [0.5, 0.5, 0, 0], F: [0, 1, 0, 0] };
  const twin = { A: [2, 2, 2, 0], B: [0, 0, 0, 0], C: [0, 0, 0, 0], D: [0, 0, 0, 0], E: [0, 0, 0, 0], F: [0, 0, 0, 0] };

  it('ranks by the summed contribution minus beta times the twin\'s, over the range only', () => {
    // Range days 1..2: A 2 - 0.5 x 4 = 0, B 4, C 0, D 0, E 0.5, F 1.
    const top = topContributors(t, twin, 0.5, { first: 1, last: 2 }, 3);
    expect(top).toEqual([
      { contract: 'B', contribution: 4 },
      { contract: 'F', contribution: 1 },
      { contract: 'E', contribution: 0.5 },
    ]);
  });

  it('breaks ties by contract id, takes five by default and treats a non-finite beta as 0', () => {
    const top = topContributors(t, twin, Number.NaN, { first: 0, last: 3 });
    expect(top.map((x) => x.contract)).toEqual(['A', 'D', 'B', 'E', 'F']);
    expect(top[0].contribution).toBe(12);
    const tied = topContributors({ Z: [1], Y: [1], X: [2] }, {}, 1, { first: 0, last: 0 }, 2);
    expect(tied.map((x) => x.contract)).toEqual(['X', 'Y']);
  });
});

describe('contractsOfAssets', () => {
  it('selects by asset key, every contract of the asset', () => {
    const contracts = [
      { id: 'ETHUSDT#1', assetKey: 'ETH' },
      { id: 'BTCUSDT#1', assetKey: 'BTC' },
      { id: 'BTCUSDT#2', assetKey: 'BTC' },
      { id: 'ETHWUSDT#1', assetKey: 'ETHW' },
      { id: 'BTCSTUSDT#1', assetKey: 'BTCST' },
    ];
    expect(contractsOfAssets(contracts, BTC_ETH_ASSETS)).toEqual(['BTCUSDT#1', 'BTCUSDT#2', 'ETHUSDT#1']);
  });
});

describe('firstDefinedMemberDay (gate 1)', () => {
  const start = utc(2021, 1, 1);
  const input = (symbol: string, n: number, spans: Array<[number, number]>): TrendSymbolInput => ({
    symbol,
    t: Array.from({ length: n }, (_, i) => start + i * DAY_MS),
    open: new Array(n).fill(1),
    close: new Array(n).fill(1),
    listingDay: start,
    settlements: [],
    membership: spans.map(([from, to]) => ({ from, to, rank: 1 })),
  });
  const paths = (n: number, firstDefined: number): RulePaths => {
    const defined = new Uint8Array(n);
    for (let i = firstDefined; i < n; i++) defined[i] = 1;
    return { signal: new Float64Array(n), size: new Float64Array(n), decide: () => true, rebalance: { kind: 'on-decision' }, defined };
  };
  const feb1 = utc(2021, 2, 1);
  const mar1 = utc(2021, 3, 1);
  const apr1 = utc(2021, 4, 1);

  it('is the first member day whose deciding bar (the day before) is defined', () => {
    const a = input('A', 120, [[feb1, apr1]]);
    // Bar 40 is 2021-02-10: day 2021-02-11 is the first held on a defined decision.
    expect(firstDefinedMemberDay([a], { A: paths(120, 40) }, feb1, apr1)).toBe(utc(2021, 2, 11));
    // Defined from the start: the first member day.
    expect(firstDefinedMemberDay([a], { A: paths(120, 0) }, feb1, apr1)).toBe(feb1);
  });

  it('takes the earliest across inputs, ignores non-member days and needs a bar the day before', () => {
    const a = input('A', 120, [[mar1, apr1]]);
    const b = input('B', 120, [[feb1, mar1]]);
    expect(firstDefinedMemberDay([a, b], { A: paths(120, 0), B: paths(120, 50) }, feb1, apr1)).toBe(utc(2021, 2, 21));
    const late = { ...input('L', 10, [[feb1, mar1]]), t: Array.from({ length: 10 }, (_, i) => feb1 + i * DAY_MS) };
    expect(firstDefinedMemberDay([late], { L: paths(10, 0) }, feb1, mar1)).toBe(utc(2021, 2, 2));
    expect(firstDefinedMemberDay([a], { A: paths(120, 119) }, feb1, apr1)).toBeNull();
  });
});

describe('windowAlpha and yearAlphaBetas', () => {
  const days = Array.from({ length: 800 }, (_, k) => utc(2021, 3, 1) + k * DAY_MS);
  let s = 3;
  const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
  const twin = days.map(() => noise());
  const t = twin.map((x, k) => 0.0005 + 0.5 * x + (k % 3 === 0 ? 0.001 : -0.0005));

  it('regresses over the days of [from, to) only', () => {
    const w = windowAlpha(days, t, twin, utc(2022, 1, 1), utc(2023, 1, 1));
    const idx = days.map((d, k) => (d >= utc(2022, 1, 1) && d < utc(2023, 1, 1) ? k : -1)).filter((k) => k >= 0);
    expect(w.days).toBe(365);
    expect(w.alpha).toBe(annualAlpha(t, twin, idx).alpha);
    expect(w.beta).toBeCloseTo(annualAlpha(t, twin, idx).beta, 15);
    expect(windowAlpha(days, t, twin, utc(2030, 1, 1), utc(2031, 1, 1)).alpha).toBeNaN();
  });

  it('gives each calendar year, 2021 from the first day', () => {
    const years = yearAlphaBetas(days, t, twin, [2021, 2022, 2023]);
    expect(years.map((y) => y.days)).toEqual([306, 365, 129]);
    expect(years[1].alpha).toBe(windowAlpha(days, t, twin, utc(2022, 1, 1), utc(2023, 1, 1)).alpha);
    expect(years[0].beta).toBeCloseTo(0.5, 1);
  });
});

describe('rejectionRates (gate 4 null size)', () => {
  it('counts each null and both below the level', () => {
    const r = rejectionRates([
      { wrappedP: 0.01, alignedP: 0.2 },
      { wrappedP: 0.04, alignedP: 0.03 },
      { wrappedP: 0.05, alignedP: 0.01 },
      { wrappedP: 0.5, alignedP: 0.5 },
    ]);
    expect(r).toEqual({ wrapped: 0.5, aligned: 0.5, both: 0.25 });
    expect(rejectionRates([]).both).toBeNaN();
  });
});

describe('evaluateBroadGates', () => {
  const passing: BroadGateInputs = {
    sampleDays: 1948,
    startLaterThan20210701: false,
    sharpeCiLow: 0.1,
    alphaCiLow: 0.01,
    wrappedP: 0.01,
    alignedP: 0.03,
    drops: [
      { label: '2020', alpha: 0.02 },
      { label: 'legends ten', alpha: 0.01 },
    ],
    yearAlphas: [
      { year: 2021, alpha: 0.1 },
      { year: 2022, alpha: -0.1 },
      { year: 2023, alpha: 0.1 },
      { year: 2024, alpha: -0.1 },
      { year: 2025, alpha: 0.1 },
      { year: 2026, alpha: -0.5 },
    ],
    stressAlpha: 0.01,
    ex2021Alpha: 0.01,
  };
  const byName = (x: BroadGateInputs) => Object.fromEntries(evaluateBroadGates(x).map((g) => [g.name, g]));

  it('passes every gate but 8, which is pending, so the verdict waits for the trials', () => {
    const gates = evaluateBroadGates(passing);
    expect(gates.map((g) => g.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(gates.map((g) => g.name)).toEqual(['sample', 'expectancy', 'twin', 'timing', 'cohorts', 'years', 'stress', 'trials', 'ex2021']);
    expect(gates.filter((g) => g.pass !== true).map((g) => g.name)).toEqual(['trials']);
    expect(gates[7].pass).toBeNull();
    expect(broadVerdict(gates)).toBe('pending-trials');
    // 3 of 5 gated years positive is exactly 60%; 2026 does not count.
    expect(byName(passing).years.value).toBe(0.6);
  });

  it('gate 1 needs 1,825 days and fails by construction when the universe starts after 2021-07-01', () => {
    expect(byName({ ...passing, sampleDays: 1824 }).sample.pass).toBe(false);
    expect(byName({ ...passing, sampleDays: 1825 }).sample.pass).toBe(true);
    const late = byName({ ...passing, startLaterThan20210701: true });
    expect(late.sample.pass).toBe(false);
    expect(late.sample.note).toMatch(/by construction/);
  });

  it('gate 4 takes the larger p: both nulls must be under 0.05', () => {
    expect(byName({ ...passing, wrappedP: 0.049, alignedP: 0.05 }).timing.pass).toBe(false);
    expect(byName({ ...passing, wrappedP: 0.06, alignedP: 0.001 }).timing.value).toBe(0.06);
    expect(byName({ ...passing, wrappedP: 0.049, alignedP: 0.0499 }).timing.pass).toBe(true);
    expect(byName({ ...passing, alignedP: Number.NaN }).timing.pass).toBe(false);
  });

  it('gate 5 fails when any drop leaves alpha at or below zero, or undefined, and names it', () => {
    const g = byName({ ...passing, drops: [...passing.drops, { label: 'top five', alpha: 0 }, { label: 'BTC and ETH', alpha: Number.NaN }] });
    expect(g.cohorts.pass).toBe(false);
    expect(g.cohorts.value).toBe(2);
    expect(g.cohorts.threshold).toBe(4);
    expect(g.cohorts.note).toMatch(/top five, BTC and ETH$/);
    expect(byName({ ...passing, drops: [] }).cohorts.pass).toBe(false);
  });

  it('gate 6 counts a missing or undefined gated year as not positive', () => {
    const g = byName({ ...passing, yearAlphas: passing.yearAlphas.filter((y) => y.year !== 2025) });
    expect(g.years.value).toBe(0.4);
    expect(g.years.pass).toBe(false);
  });

  it('gates 2, 3, 7 and 9 need strictly positive values', () => {
    const g = byName({ ...passing, sharpeCiLow: 0, alphaCiLow: -0.01, stressAlpha: 0, ex2021Alpha: Number.NaN });
    expect([g.expectancy.pass, g.twin.pass, g.stress.pass, g.ex2021.pass]).toEqual([false, false, false, false]);
    expect(g.ex2021.value).toBeNull();
    expect(broadVerdict(evaluateBroadGates({ ...passing, stressAlpha: 0 }))).toBe('fail');
  });
});
