import type { ControlEvidence } from './types';
import { SCORER_CONFIG_VERSION } from '@/lib/signals/config-version';
import { STRATEGY_EXIT_LEVEL, TIER_BUY_CUTOFF } from '@/lib/signals/calibration';

/**
 * What the research record says about the rule the ticket describes.
 *
 * The ticket's rule is `createScoreThresholdStrategy`, the research `control`
 * family, so these are the only recorded numbers that describe it. They are
 * copied from the result tables in the header of
 * `scripts/research/strategy-families.ts`, which holds the full run
 * parameters. Nothing here is recomputed.
 *
 * Only 15m and 1h were measured like for like under the current scorer (v8)
 * and today's 28 / 7 levels, re-run on 2026-10-02 on the same dataset as the
 * v7 controls they replace (15m v7 -0.1175%, 1h v7 -0.0687%). 5m, 4h and 1d exist only from Phase 4, run on
 * the scorer before v5 with entry 24 and exit 6, so those rows describe an
 * earlier version of the rule. 1m was never measured. The live SignalOutcome
 * record is a different measurement (a close-to-close return over a fixed hold
 * with no stop) and is deliberately not mixed in here.
 */
const PHASE_4_PROVENANCE =
  'Phase 4, 2026-09-18: dataset 3fdeac9e, commit 30a56ef, entry 24 / exit 6 on the scorer before v5, ten symbols, six rolling windows, standard fees, slippage and funding';

const V8_PROVENANCE =
  'Session 22, 2026-10-02: dataset e84cd66dbe01, image from 90c2eb5, entry 28 / exit 7 under configVersion 8, ten symbols, lockbox on, standard fees, slippage and funding';

export const CONTROL_EVIDENCE: Record<string, ControlEvidence> = {
  '1m': {
    interval: '1m',
    status: 'none',
    label: 'No research record',
    provenance: 'The composite control was never measured at 1m.',
    thresholds: null,
    trades: null,
    expectancyPercent: null,
    ciLowPercent: null,
    ciHighPercent: null,
    medianHoldBars: null,
    sdPercentRaw: null,
    sdPercentEffective: null,
    tradesPerDay: null,
    verdict: 'Unmeasured: nothing in the record supports or rejects this rule at 1m.',
    configVersion: null,
  },
  '5m': {
    interval: '5m',
    status: 'stale',
    label: 'Phase 4 control, 2026-09-18',
    provenance: PHASE_4_PROVENANCE,
    thresholds: { entry: 24, exit: 6 },
    trades: 19414,
    expectancyPercent: -0.178,
    ciLowPercent: -0.188,
    ciHighPercent: null,
    medianHoldBars: null,
    sdPercentRaw: 0.424,
    sdPercentEffective: 0.78,
    tradesPerDay: 115.31,
    verdict: 'Lost after costs on an earlier version of the rule; not re-measured under v7.',
    configVersion: null,
  },
  '15m': {
    interval: '15m',
    status: 'current',
    label: 'v8 control, 2026-10-02',
    provenance: V8_PROVENANCE,
    thresholds: { entry: 28, exit: 7 },
    trades: 4766,
    expectancyPercent: -0.1345,
    ciLowPercent: -0.1914,
    ciHighPercent: -0.0793,
    medianHoldBars: 7,
    sdPercentRaw: 1.001,
    sdPercentEffective: 1.974,
    tradesPerDay: 23.87,
    verdict: 'Loses after costs: the whole 95% interval is below zero.',
    configVersion: 8,
  },
  '1h': {
    interval: '1h',
    status: 'current',
    label: 'v8 control, 2026-10-02',
    provenance: V8_PROVENANCE,
    thresholds: { entry: 28, exit: 7 },
    trades: 8467,
    expectancyPercent: -0.0551,
    ciLowPercent: -0.1527,
    ciHighPercent: 0.0458,
    medianHoldBars: 7,
    sdPercentRaw: 2.42,
    sdPercentEffective: 4.658,
    tradesPerDay: 8.27,
    verdict: 'Negative estimate after costs; the interval spans zero, so it is not shown to beat breakeven either.',
    configVersion: 8,
  },
  '4h': {
    interval: '4h',
    status: 'stale',
    label: 'Phase 4 control, 2026-09-18',
    provenance: PHASE_4_PROVENANCE,
    thresholds: { entry: 24, exit: 6 },
    trades: 1619,
    expectancyPercent: 0.016,
    ciLowPercent: -0.424,
    ciHighPercent: null,
    medianHoldBars: null,
    sdPercentRaw: 5.828,
    sdPercentEffective: 9.21,
    tradesPerDay: 1.07,
    verdict: 'About breakeven on an earlier version of the rule, with a wide interval and no timing edge over random entries.',
    configVersion: null,
  },
  '1d': {
    interval: '1d',
    status: 'stale',
    label: 'Phase 4 control, 2026-09-18',
    provenance: PHASE_4_PROVENANCE,
    thresholds: { entry: 24, exit: 6 },
    trades: 157,
    expectancyPercent: -1.23,
    ciLowPercent: -3.566,
    ciHighPercent: null,
    medianHoldBars: null,
    sdPercentRaw: 13.633,
    sdPercentEffective: 15.92,
    tradesPerDay: 0.14,
    verdict: 'Lost over 1% per trade on an earlier version of the rule, on a small sample.',
    configVersion: null,
  },
};

/**
 * The recorded row for an interval, with its status DERIVED for today: current
 * only when it was measured under the live scorer's configVersion AND at
 * today's entry and exit levels. A scorer change therefore turns every row
 * measured before it stale by itself, without anyone editing the table, until
 * the control is re-measured under the new version.
 */
export function evidenceFor(interval: string): ControlEvidence {
  const row =
    CONTROL_EVIDENCE[interval] ?? {
      interval,
      status: 'none' as const,
      label: 'No research record',
      provenance: `The composite control was never measured at ${interval}.`,
      thresholds: null,
      trades: null,
      expectancyPercent: null,
      ciLowPercent: null,
      ciHighPercent: null,
      medianHoldBars: null,
      sdPercentRaw: null,
      sdPercentEffective: null,
      tradesPerDay: null,
      verdict: `Unmeasured: nothing in the record supports or rejects this rule at ${interval}.`,
      configVersion: null,
    };
  if (row.status === 'none') return row;
  const current =
    row.configVersion === SCORER_CONFIG_VERSION &&
    row.thresholds?.entry === TIER_BUY_CUTOFF &&
    row.thresholds?.exit === STRATEGY_EXIT_LEVEL;
  return { ...row, status: current ? 'current' : 'stale' };
}

/**
 * What a recorded run says, as one of four kinds the card styles by:
 * `loses` when the whole 95% interval is below zero, `negative` when the
 * estimate is below zero but the interval does not exclude zero (or only its
 * low bound was recorded), `other` for a non-negative estimate, and
 * `unmeasured` when there is no run.
 */
export type EvidenceVerdictKind = 'loses' | 'negative' | 'other' | 'unmeasured';

export function evidenceVerdictKind(evidence: ControlEvidence): EvidenceVerdictKind {
  if (evidence.expectancyPercent === null) return 'unmeasured';
  if (evidence.ciHighPercent !== null && evidence.ciHighPercent < 0) return 'loses';
  if (evidence.expectancyPercent < 0) return 'negative';
  return 'other';
}
