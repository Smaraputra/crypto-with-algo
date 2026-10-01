/**
 * The funding carry kill criterion, exactly as pre-registered in the header of
 * carry-sim.ts on 2026-10-02. Pure: reads computed statistics, decides nothing
 * else. The criterion is judged on R0 and on the selected R1 separately; R1's
 * timing claim is a separate, stricter question.
 */
import type { AnnualStat } from './carry-sim';

/** The stated USDT savings hurdle, a year (an assumption, not a measurement). */
export const SAVINGS_HURDLE_ANNUAL = 0.05;

/** At most this many of 2023, 2024, 2025, 2026H1 may be negative. */
export const MAX_NEGATIVE_PERIODS = 1;

/** R1's timing null must reach this. */
export const TIMING_P = 0.05;

export interface CarryGate {
  name: 'significance' | 'hurdle' | 'periods';
  pass: boolean;
  value: number;
  threshold: number;
  note: string;
}

export interface RuleVerdict {
  gates: CarryGate[];
  /** True when the criterion fires for this rule. */
  killed: boolean;
}

export function evaluateCarryRule(
  stat: AnnualStat,
  periods: Array<{ label: string; annual: number }>
): RuleVerdict {
  const negative = periods.filter((p) => Number.isFinite(p.annual) && p.annual < 0).length;
  const gates: CarryGate[] = [
    {
      name: 'significance',
      pass: Number.isFinite(stat.ciLow) && stat.ciLow > 0,
      value: stat.ciLow,
      threshold: 0,
      note: 'pooled annualised net return per unit notional, 95% CI low',
    },
    {
      name: 'hurdle',
      pass: Number.isFinite(stat.annual) && stat.annual >= SAVINGS_HURDLE_ANNUAL,
      value: stat.annual,
      threshold: SAVINGS_HURDLE_ANNUAL,
      note: 'point estimate against the stated USDT savings yield',
    },
    {
      name: 'periods',
      pass: negative <= MAX_NEGATIVE_PERIODS,
      value: negative,
      threshold: MAX_NEGATIVE_PERIODS,
      note: `negative calendar periods: ${periods
        .filter((p) => p.annual < 0)
        .map((p) => p.label)
        .join(', ') || 'none'}`,
    },
  ];
  return { gates, killed: gates.some((g) => !g.pass) };
}

export interface TimingVerdict {
  beatsR0: boolean;
  timingP: number;
  /** R1 is a timing finding only when both hold. */
  isTimingFinding: boolean;
}

export function evaluateR1Timing(difference: AnnualStat, timingP: number): TimingVerdict {
  const beatsR0 = Number.isFinite(difference.ciLow) && difference.ciLow > 0;
  return { beatsR0, timingP, isTimingFinding: beatsR0 && timingP < TIMING_P };
}
