/**
 * The broad flow phase's eight gates, exactly as pre-registered in the header of
 * broad-flow.ts (GATES) on 2026-10-08, and the pure window statistics they read.
 * Pure: reads computed statistics and runs nothing. Everything not restated here is
 * the broad trend phase's (broad-gates.ts): blocks, draws, seeds, the cohort merge,
 * the legends ten, BTC and ETH, the stress multiples.
 *
 * Gate 7 (the deflated Sharpe at N = 3) is computed once across DO, W and WO by
 * broad-flow-dsr.ts, so a single report records it as pending (pass null). The
 * control D is reported, never a trial: its gates are computed for information and
 * its verdict is 'control'. The choices the header leaves open are recorded in
 * broad-flow.ts's implementation notes (F1 to F17).
 */
import { BROAD_BLOCK_DAYS, BROAD_BOOT_DRAWS, BROAD_BOOT_SEED } from './broad-gates';
import type { FlowGate } from './report-schema';
import { annualisedSharpe } from './trend-sim';

/** Header TRIALS AND LEDGER: N = 3 for gate 7; 1,729 after the broad trend phase plus these three. */
export const FLOW_PHASE_TRIALS = 3;
export const FLOW_PROGRAM_TRIALS = 1732;
export const FLOW_DSR_MIN = 0.95;

/** Gate 1: portfolio days from the first day the book holds a position. */
export const FLOW_MIN_SAMPLE_DAYS = 1825;
/** Gate 2: circular blocks of 60 days, 2,000 draws, seed 42 (as the broad trend phase); 20 and 120 reported. */
export const FLOW_BLOCK_DAYS = BROAD_BLOCK_DAYS;
export const FLOW_BLOCK_SENSITIVITY = [20, 120] as const;
export const FLOW_BOOT_DRAWS = BROAD_BOOT_DRAWS;
export const FLOW_BOOT_SEED = BROAD_BOOT_SEED;
/** Gate 3: both nulls under 0.05, the larger p gating, 200 draws each, seed 7. */
export const FLOW_TIMING_P = 0.05;
export const FLOW_NULL_DRAWS = 200;
export const FLOW_NULL_SEED = 7;
/** Gate 5: 2021 (from the sample start) to 2025, at least 60% positive; 2026 reported. */
export const FLOW_GATED_YEARS = [2021, 2022, 2023, 2024, 2025] as const;
export const FLOW_REPORT_YEARS = [2021, 2022, 2023, 2024, 2025, 2026] as const;
export const FLOW_MIN_POSITIVE_YEAR_SHARE = 0.6;
/** Gate 8: 2022-07-01 to 2026-06-30, after the paper's sample (end exclusive below). */
export const AFTER_PAPER_FROM = Date.UTC(2022, 6, 1);
export const AFTER_PAPER_TO = Date.UTC(2026, 6, 1);
/** Reported: the overlap with the paper's window, 2021-03 to 2022-06. */
export const PAPER_OVERLAP_FROM = Date.UTC(2021, 2, 1);
export const PAPER_OVERLAP_TO = Date.UTC(2022, 6, 1);

/** Arithmetic mean; NaN when empty. */
export function meanOf(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export interface WindowStat {
  days: number;
  /** Mean daily book return; NaN without days. */
  mean: number;
  /** Annualised Sharpe; NaN with fewer than two days or no variance. */
  sharpe: number;
}

/** Mean and Sharpe of the daily returns whose day lies in [from, to). */
export function windowStats(days: readonly number[], returns: readonly number[], from: number, to: number): WindowStat {
  const xs: number[] = [];
  for (let i = 0; i < days.length; i++) if (days[i] >= from && days[i] < to) xs.push(returns[i]);
  return { days: xs.length, mean: meanOf(xs), sharpe: annualisedSharpe(xs) };
}

/** Calendar-year windows (gate 5 and the reported years). */
export function yearStats(
  days: readonly number[],
  returns: readonly number[],
  years: readonly number[]
): Array<WindowStat & { year: number }> {
  return years.map((year) => ({ year, ...windowStats(days, returns, Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1)) }));
}

export interface FlowGateInputs {
  /** Portfolio days from the first day the book holds a position. */
  sampleDays: number;
  sharpeCiLow: number;
  /** Null when the null did not run (an undefined observed Sharpe gives p = 1, not null). */
  permutedP: number | null;
  alignedP: number | null;
  /** Every gate 4 drop: each listing-year cohort, the legends ten, BTC and ETH, the top five. */
  drops: Array<{ label: string; mean: number }>;
  yearMeans: Array<{ year: number; mean: number }>;
  stressMean: number;
  afterPaperMean: number;
  /** The control D: gate 7 does not apply. */
  control: boolean;
}

const finite = (v: number) => (Number.isFinite(v) ? v : null);
const fmtP = (p: number | null) => (p === null ? 'not run' : p.toFixed(4));

export function evaluateFlowGates(x: FlowGateInputs): FlowGate[] {
  const timingP = x.permutedP === null || x.alignedP === null ? Number.NaN : Math.max(x.permutedP, x.alignedP);
  const failedDrops = x.drops.filter((d) => !(d.mean > 0)).map((d) => d.label);
  const gated = FLOW_GATED_YEARS.map((year) => x.yearMeans.find((y) => y.year === year)?.mean ?? Number.NaN);
  const positiveYears = gated.filter((m) => m > 0).length;
  const yearShare = positiveYears / FLOW_GATED_YEARS.length;
  return [
    {
      id: 1,
      name: 'sample',
      pass: x.sampleDays >= FLOW_MIN_SAMPLE_DAYS,
      value: x.sampleDays,
      threshold: FLOW_MIN_SAMPLE_DAYS,
      note: 'portfolio days from the first day the book holds a position',
    },
    {
      id: 2,
      name: 'expectancy',
      pass: x.sharpeCiLow > 0,
      value: finite(x.sharpeCiLow),
      threshold: 0,
      note: 'annualised Sharpe of daily book returns, circular block bootstrap (60 days, 2,000 draws, seed 42) 95% CI low',
    },
    {
      id: 3,
      name: 'timing',
      pass: timingP < FLOW_TIMING_P,
      value: finite(timingP),
      threshold: FLOW_TIMING_P,
      note: `the larger p of the permuted (${fmtP(x.permutedP)}) and aligned (${fmtP(x.alignedP)}) nulls`,
    },
    {
      id: 4,
      name: 'cohorts',
      pass: x.drops.length > 0 && failedDrops.length === 0,
      value: x.drops.length - failedDrops.length,
      threshold: x.drops.length,
      note: `drops with mean daily book return > 0 (listing-year cohorts, the legends ten, BTC and ETH, the top five); not positive without: ${failedDrops.join(', ') || 'none'}`,
    },
    {
      id: 5,
      name: 'years',
      pass: yearShare >= FLOW_MIN_POSITIVE_YEAR_SHARE,
      value: yearShare,
      threshold: FLOW_MIN_POSITIVE_YEAR_SHARE,
      note: `${positiveYears} of ${FLOW_GATED_YEARS.length} calendar years 2021 (from the sample start) to 2025 with mean daily book return > 0`,
    },
    {
      id: 6,
      name: 'stress',
      pass: x.stressMean > 0,
      value: finite(x.stressMean),
      threshold: 0,
      note: 'mean daily book return at 1.5x fees, 2x every slippage tier (and the leave slippage) and a 4% delisting haircut',
    },
    {
      id: 7,
      name: 'trials',
      pass: null,
      value: null,
      threshold: FLOW_DSR_MIN,
      note: x.control
        ? 'the daily raw control is not a trial: gate 7 does not apply'
        : `deflated Sharpe at N = ${FLOW_PHASE_TRIALS}, computed once across DO, W and WO (broad-flow-dsr.ts): PENDING`,
    },
    {
      id: 8,
      name: 'after-paper',
      pass: x.afterPaperMean > 0,
      value: finite(x.afterPaperMean),
      threshold: 0,
      note: 'mean daily book return over 2022-07-01 to 2026-06-30, the same run',
    },
  ];
}

/** 'control' for D; else 'fail' when any decided gate fails, 'pending-trials' when all but gate 7 pass. */
export function flowVerdict(gates: readonly FlowGate[], control: boolean): 'fail' | 'pending-trials' | 'pass' | 'control' {
  if (control) return 'control';
  if (gates.some((g) => g.pass === false)) return 'fail';
  if (gates.some((g) => g.pass === null)) return 'pending-trials';
  return 'pass';
}
