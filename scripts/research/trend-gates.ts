/**
 * The trend gates, exactly as pre-registered in the header of trend-sim.ts on
 * 2026-10-02. Pure: reads computed statistics and decides nothing else.
 *
 * Gate 8 (deflated Sharpe at N = 11) is computed ONCE across all eleven
 * trials in one unit, so a single rule's report cannot decide it: it is
 * recorded as pending (pass null) here and settled by the phase-level step
 * after every trial has run. A rule that fails any other gate fails whatever
 * gate 8 says.
 */

/** Gate 1: at least five years of portfolio days in PRIMARY. */
export const MIN_SAMPLE_DAYS = 5 * 365;
/** Gate 4. */
export const TIMING_P = 0.05;
/** Gate 6: share of calendar years 2020 to 2025 with a positive alpha. */
export const MIN_POSITIVE_YEAR_SHARE = 0.6;
export const GATED_YEARS = [2020, 2021, 2022, 2023, 2024, 2025] as const;
/** Gate 8, at the phase count. */
export const PHASE_TRIALS = 11;
export const DEFLATED_SHARPE_MIN = 0.95;

export interface TrendGate {
  id: number;
  name: 'sample' | 'expectancy' | 'twin' | 'timing' | 'symbols' | 'years' | 'stress' | 'trials' | 'consistency';
  /** Null while pending (gate 8 until the phase-level step). */
  pass: boolean | null;
  value: number | null;
  threshold: number;
  note: string;
}

export interface TrendGateInputs {
  sampleDays: number;
  sharpeCiLow: number;
  alphaCiLow: number;
  timingP: number;
  dropOneAlphas: Record<string, number>;
  yearAlphas: Array<{ year: number; alpha: number }>;
  stressAlpha: number;
  consistencyAlpha: number;
}

const finite = (v: number) => (Number.isFinite(v) ? v : null);

export function evaluateTrendGates(x: TrendGateInputs): TrendGate[] {
  const drops = Object.entries(x.dropOneAlphas);
  const negativeDrops = drops.filter(([, a]) => !(a > 0)).map(([s]) => s);
  const years = x.yearAlphas.filter((y) => (GATED_YEARS as readonly number[]).includes(y.year));
  const positiveYears = years.filter((y) => y.alpha > 0).length;
  const yearShare = years.length > 0 ? positiveYears / years.length : Number.NaN;
  return [
    {
      id: 1,
      name: 'sample',
      pass: x.sampleDays >= MIN_SAMPLE_DAYS,
      value: x.sampleDays,
      threshold: MIN_SAMPLE_DAYS,
      note: 'portfolio days in PRIMARY',
    },
    {
      id: 2,
      name: 'expectancy',
      pass: x.sharpeCiLow > 0,
      value: finite(x.sharpeCiLow),
      threshold: 0,
      note: 'annualised Sharpe, circular block bootstrap (60 days) 95% CI low',
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
      pass: x.timingP < TIMING_P,
      value: finite(x.timingP),
      threshold: TIMING_P,
      note: 'one-sided p of the alpha against signal paths shifted at least 365 days, sizing on true dates',
    },
    {
      id: 5,
      name: 'symbols',
      pass: drops.length > 0 && negativeDrops.length === 0,
      value: drops.length - negativeDrops.length,
      threshold: drops.length,
      note: `drop-one-symbol portfolios with alpha > 0; not positive without: ${negativeDrops.join(', ') || 'none'}`,
    },
    {
      id: 6,
      name: 'years',
      pass: yearShare >= MIN_POSITIVE_YEAR_SHARE,
      value: finite(yearShare),
      threshold: MIN_POSITIVE_YEAR_SHARE,
      note: `${positiveYears} of ${years.length} calendar years 2020-2025 with alpha > 0`,
    },
    {
      id: 7,
      name: 'stress',
      pass: x.stressAlpha > 0,
      value: finite(x.stressAlpha),
      threshold: 0,
      note: 'alpha point estimate at 1.5x fees and 2x slippage',
    },
    {
      id: 8,
      name: 'trials',
      pass: null,
      value: null,
      threshold: DEFLATED_SHARPE_MIN,
      note: `deflated Sharpe at N = ${PHASE_TRIALS}, computed once across all eleven trials at phase level: PENDING`,
    },
    {
      id: 9,
      name: 'consistency',
      pass: x.consistencyAlpha > 0,
      value: finite(x.consistencyAlpha),
      threshold: 0,
      note: 'alpha point estimate on perp closes, 2022-01-01 to 2026-06-30',
    },
  ];
}

/** 'fail' when any decided gate fails; 'pending-trials' when all but gate 8 pass. */
export function trendVerdict(gates: TrendGate[]): 'fail' | 'pending-trials' | 'pass' {
  if (gates.some((g) => g.pass === false)) return 'fail';
  if (gates.some((g) => g.pass === null)) return 'pending-trials';
  return 'pass';
}
