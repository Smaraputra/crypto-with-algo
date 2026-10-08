/**
 * The broad trend phase's nine gates, exactly as pre-registered in the header of
 * broad-trend.ts (GATES) on 2026-10-07, and the pure helpers that build their
 * inputs: listing-year cohorts with the merge rule, the five largest alpha
 * contributors, the first day a member holds a defined signal, and calendar-year
 * and window alphas. Pure: reads computed statistics and runs nothing. The legends
 * gates (trend-gates.ts) are untouched.
 *
 * Gate 8 (the deflated Sharpe at N = 16) is computed once across the five broad
 * trials by broad-dsr.ts, so a single report records it as pending (pass null).
 * The choices the header leaves open are recorded in broad-trend.ts's
 * implementation notes (A5).
 */
import type { BroadGate } from './report-schema';
import { DAY_MS, type RulePaths } from './trend-signals';
import { annualAlpha, barIndex, type TrendSymbolInput } from './trend-sim';

/** Header TRIALS: the five trials, and gate 8's N (the eleven legends trials plus these five). */
export const BROAD_TRIAL_IDS = ['TF1', 'TF2', 'TF3', 'TF4', 'C3'] as const;
export const BROAD_PHASE_TRIALS = 16;
/** Header TRIALS AND LEDGER: 1,724 after the legends phase, plus these five. */
export const BROAD_PROGRAM_TRIALS = 1729;
export const BROAD_DSR_MIN = 0.95;

/** Gate 1: portfolio days from the first day any member holds a defined signal. */
export const BROAD_MIN_SAMPLE_DAYS = 1825;
/** Gates 2 and 3: circular blocks of 60 days, 2,000 draws, seed 42; 20 and 120 reported. */
export const BROAD_BLOCK_DAYS = 60;
export const BROAD_BLOCK_SENSITIVITY = [20, 120] as const;
export const BROAD_BOOT_DRAWS = 2000;
export const BROAD_BOOT_SEED = 42;
/** Gate 4: both nulls under 0.05, 200 draws each, seed 7; the null size on 50 permuted universes, seed 11. */
export const BROAD_TIMING_P = 0.05;
export const BROAD_NULL_DRAWS = 200;
export const BROAD_NULL_SEED = 7;
export const NULL_SIZE_UNIVERSES = 50;
export const NULL_SIZE_SEED = 11;
/** Gate 5: a listing-year cohort under 10% of member-days is merged. */
export const COHORT_MIN_SHARE = 0.1;
export const LEGENDS_TEN_ASSETS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'LINK'] as const;
export const BTC_ETH_ASSETS = ['BTC', 'ETH'] as const;
export const TOP_CONTRIBUTORS = 5;
/** Gate 6: 2021 (from the sample start) to 2025 gated; 2026 reported. */
export const BROAD_GATED_YEARS = [2021, 2022, 2023, 2024, 2025] as const;
export const BROAD_REPORT_YEARS = [2021, 2022, 2023, 2024, 2025, 2026] as const;
export const BROAD_MIN_POSITIVE_YEAR_SHARE = 0.6;
/** Gate 7: 1.5x fees (stressBroad doubles the slippage tiers and the haircut); a 5% haircut reported. */
export const STRESS_FEE_MULTIPLE = 1.5;
export const STRESS_REPORTED_HAIRCUT = 0.05;
/** Gate 9: the legends CONSISTENCY window, 2022-01-01 to 2026-06-30 (end exclusive below). */
export const EX2021_FROM = Date.UTC(2022, 0, 1);
export const EX2021_TO = Date.UTC(2026, 6, 1);

export interface CohortContract {
  id: string;
  /** UTC year of the contract's first bar. */
  listingYear: number;
  memberDays: number;
}

export interface Cohort {
  label: string;
  years: number[];
  contracts: string[];
  memberDays: number;
  /** Share of all member-days; null when there are none. */
  share: number | null;
}

/**
 * Header gate 5: the listing-year cohorts, with "a cohort under 10% of
 * member-days merged into the next older one, the oldest into the next
 * younger". Repeated until no cohort is under the share or one remains, taking
 * the youngest cohort under the share first; a merged cohort is a cohort, so it
 * merges again while it stays under. Labels join the years with '+'.
 */
export function listingYearCohorts(contracts: readonly CohortContract[], minShare = COHORT_MIN_SHARE): Cohort[] {
  const total = contracts.reduce((s, c) => s + c.memberDays, 0);
  const byYear = new Map<number, { years: number[]; contracts: string[]; memberDays: number }>();
  for (const c of contracts) {
    const group = byYear.get(c.listingYear) ?? { years: [c.listingYear], contracts: [], memberDays: 0 };
    group.contracts.push(c.id);
    group.memberDays += c.memberDays;
    byYear.set(c.listingYear, group);
  }
  const groups = [...byYear.values()].sort((a, b) => a.years[0] - b.years[0]);
  if (total > 0) {
    while (groups.length > 1) {
      let idx = -1;
      for (let g = groups.length - 1; g >= 0; g--) {
        if (groups[g].memberDays < minShare * total) {
          idx = g;
          break;
        }
      }
      if (idx === -1) break;
      const into = groups[idx === 0 ? 1 : idx - 1];
      into.years.push(...groups[idx].years);
      into.contracts.push(...groups[idx].contracts);
      into.memberDays += groups[idx].memberDays;
      groups.splice(idx, 1);
    }
  }
  return groups.map((g) => {
    const years = [...g.years].sort((a, b) => a - b);
    return {
      label: years.join('+'),
      years,
      contracts: [...g.contracts].sort(),
      memberDays: g.memberDays,
      share: total > 0 ? g.memberDays / total : null,
    };
  });
}

/**
 * Header gate 5: the `k` contracts with the largest summed daily contribution to
 * the rule's return minus beta times the twin's, over the range. Ties by contract
 * id; a non-finite beta counts as 0 (its alpha is undefined and gate 3 fails).
 */
export function topContributors(
  t: Readonly<Record<string, readonly number[]>>,
  twin: Readonly<Record<string, readonly number[]>>,
  beta: number,
  range: { first: number; last: number },
  k = TOP_CONTRIBUTORS
): Array<{ contract: string; contribution: number }> {
  const b = Number.isFinite(beta) ? beta : 0;
  const rows = Object.keys(t).map((contract) => {
    const own = t[contract];
    const other = twin[contract];
    let sum = 0;
    for (let j = range.first; j <= range.last; j++) sum += own[j] - b * (other ? other[j] : 0);
    return { contract, contribution: sum };
  });
  rows.sort((x, y) =>
    y.contribution !== x.contribution ? y.contribution - x.contribution : x.contract < y.contract ? -1 : x.contract > y.contract ? 1 : 0
  );
  return rows.slice(0, k);
}

/** Contract ids whose asset key is one of `assets`, sorted. */
export function contractsOfAssets(contracts: ReadonlyArray<{ id: string; assetKey: string }>, assets: readonly string[]): string[] {
  const wanted = new Set(assets);
  return contracts
    .filter((c) => wanted.has(c.assetKey))
    .map((c) => c.id)
    .sort();
}

/**
 * Header gate 1: the first day d in [from, to) on which some input is a member
 * (a span covers d), has bars on d - 1 day and d, and its rule is defined at the
 * bar of d - 1 day, the close whose decision sets day d's holding. Paths without
 * a `defined` mask count as defined everywhere. Null when no such day exists.
 */
export function firstDefinedMemberDay(
  inputs: readonly TrendSymbolInput[],
  paths: Readonly<Record<string, RulePaths>>,
  from: number,
  to: number
): number | null {
  let first = Infinity;
  for (const input of inputs) {
    const defined = paths[input.symbol]?.defined;
    for (const span of input.membership ?? []) {
      const start = Math.max(span.from, from);
      const end = Math.min(span.to, to, first);
      let found = false;
      for (let d = start; d < end; d += DAY_MS) {
        const j = barIndex(input, d - DAY_MS);
        if (j === -1 || barIndex(input, d) === -1) continue;
        if (defined === undefined || defined[j] === 1) {
          first = d;
          found = true;
          break;
        }
      }
      if (found) break;
    }
  }
  return Number.isFinite(first) ? first : null;
}

/** Alpha and beta of T on T+ over the days in [from, to). */
export function windowAlpha(
  days: readonly number[],
  t: readonly number[],
  twin: readonly number[],
  from: number,
  to: number
): { days: number; alpha: number; beta: number } {
  const idx: number[] = [];
  for (let i = 0; i < days.length; i++) if (days[i] >= from && days[i] < to) idx.push(i);
  if (idx.length < 2) return { days: idx.length, alpha: Number.NaN, beta: Number.NaN };
  const { alpha, beta } = annualAlpha(t, twin, idx);
  return { days: idx.length, alpha, beta };
}

/** Calendar-year alpha and beta (gate 6 and the reported beta beside every alpha). */
export function yearAlphaBetas(
  days: readonly number[],
  t: readonly number[],
  twin: readonly number[],
  years: readonly number[]
): Array<{ year: number; alpha: number; beta: number; days: number }> {
  return years.map((year) => {
    const w = windowAlpha(days, t, twin, Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1));
    return { year, alpha: w.alpha, beta: w.beta, days: w.days };
  });
}

/** Gate 4's null size: the share of universes in which each null, and both, reject at `level` (a null p never rejects). */
export function rejectionRates(
  perUniverse: ReadonlyArray<{ wrappedP: number | null; alignedP: number | null }>,
  level = BROAD_TIMING_P
): { wrapped: number; aligned: number; both: number } {
  const n = perUniverse.length;
  if (n === 0) return { wrapped: Number.NaN, aligned: Number.NaN, both: Number.NaN };
  const count = (f: (u: { wrappedP: number; alignedP: number }) => boolean) =>
    perUniverse.filter((u) => f({ wrappedP: u.wrappedP ?? Number.NaN, alignedP: u.alignedP ?? Number.NaN })).length / n;
  return {
    wrapped: count((u) => u.wrappedP < level),
    aligned: count((u) => u.alignedP < level),
    both: count((u) => Math.max(u.wrappedP, u.alignedP) < level),
  };
}

export interface BroadGateInputs {
  /** Portfolio days from the first day any member holds a defined signal. */
  sampleDays: number;
  /** Header SAMPLE: a start later than 2021-07-01 fails gate 1 by construction. */
  startLaterThan20210701: boolean;
  sharpeCiLow: number;
  alphaCiLow: number;
  wrappedP: number;
  alignedP: number;
  /** Every gate 5 drop: each listing-year cohort, the legends ten, BTC and ETH, the top five. */
  drops: Array<{ label: string; alpha: number }>;
  yearAlphas: Array<{ year: number; alpha: number }>;
  stressAlpha: number;
  ex2021Alpha: number;
}

const finite = (v: number) => (Number.isFinite(v) ? v : null);

export function evaluateBroadGates(x: BroadGateInputs): BroadGate[] {
  const timingP = Math.max(x.wrappedP, x.alignedP);
  const failedDrops = x.drops.filter((d) => !(d.alpha > 0)).map((d) => d.label);
  const gated = BROAD_GATED_YEARS.map((year) => x.yearAlphas.find((y) => y.year === year)?.alpha ?? Number.NaN);
  const positiveYears = gated.filter((a) => a > 0).length;
  const yearShare = positiveYears / BROAD_GATED_YEARS.length;
  return [
    {
      id: 1,
      name: 'sample',
      pass: !x.startLaterThan20210701 && x.sampleDays >= BROAD_MIN_SAMPLE_DAYS,
      value: x.sampleDays,
      threshold: BROAD_MIN_SAMPLE_DAYS,
      note:
        'portfolio days from the first day any member holds a defined signal' +
        (x.startLaterThan20210701 ? '; the universe starts after 2021-07-01, so this gate fails by construction' : ''),
    },
    {
      id: 2,
      name: 'expectancy',
      pass: x.sharpeCiLow > 0,
      value: finite(x.sharpeCiLow),
      threshold: 0,
      note: 'annualised Sharpe, circular block bootstrap (60 days, 2,000 draws, seed 42) 95% CI low',
    },
    {
      id: 3,
      name: 'twin',
      pass: x.alphaCiLow > 0,
      value: finite(x.alphaCiLow),
      threshold: 0,
      note: 'annualised alpha on the always-long twin, circular block bootstrap (60 days) 95% CI low',
    },
    {
      id: 4,
      name: 'timing',
      pass: timingP < BROAD_TIMING_P,
      value: finite(timingP),
      threshold: BROAD_TIMING_P,
      note: `the larger p of the wrapped (${x.wrappedP.toFixed(4)}) and aligned (${x.alignedP.toFixed(4)}) common-shift nulls`,
    },
    {
      id: 5,
      name: 'cohorts',
      pass: x.drops.length > 0 && failedDrops.length === 0,
      value: x.drops.length - failedDrops.length,
      threshold: x.drops.length,
      note: `drops with alpha > 0 (listing-year cohorts, the legends ten, BTC and ETH, the top five); not positive without: ${failedDrops.join(', ') || 'none'}`,
    },
    {
      id: 6,
      name: 'years',
      pass: yearShare >= BROAD_MIN_POSITIVE_YEAR_SHARE,
      value: yearShare,
      threshold: BROAD_MIN_POSITIVE_YEAR_SHARE,
      note: `${positiveYears} of ${BROAD_GATED_YEARS.length} calendar years 2021 (from the sample start) to 2025 with alpha > 0`,
    },
    {
      id: 7,
      name: 'stress',
      pass: x.stressAlpha > 0,
      value: finite(x.stressAlpha),
      threshold: 0,
      note: 'alpha point estimate at 1.5x fees, 2x every slippage tier (and the leave slippage) and a 4% delisting haircut',
    },
    {
      id: 8,
      name: 'trials',
      pass: null,
      value: null,
      threshold: BROAD_DSR_MIN,
      note: `deflated Sharpe at N = ${BROAD_PHASE_TRIALS}, computed once across the five broad trials (broad-dsr.ts): PENDING`,
    },
    {
      id: 9,
      name: 'ex2021',
      pass: x.ex2021Alpha > 0,
      value: finite(x.ex2021Alpha),
      threshold: 0,
      note: 'alpha point estimate over 2022-01-01 to 2026-06-30, the same run',
    },
  ];
}

/** 'fail' when any decided gate fails; 'pending-trials' when all but gate 8 pass. */
export function broadVerdict(gates: readonly BroadGate[]): 'fail' | 'pending-trials' | 'pass' {
  if (gates.some((g) => g.pass === false)) return 'fail';
  if (gates.some((g) => g.pass === null)) return 'pending-trials';
  return 'pass';
}
