import type { ControlEvidence } from './types';

/**
 * What the research record says about the rule the ticket describes.
 *
 * The ticket's rule is `createScoreThresholdStrategy`, the research `control`
 * family, so these are the only recorded numbers that describe it. They are
 * copied from the result tables in the header of
 * `scripts/research/strategy-families.ts`, which holds the full run
 * parameters. Nothing here is recomputed.
 *
 * Only 15m and 1h were measured like for like under the current scorer (v7)
 * and today's 29 / 7.25 levels. 5m, 4h and 1d exist only from Phase 4, run on
 * the scorer before v5 with entry 24 and exit 6, so those rows describe an
 * earlier version of the rule. 1m was never measured. The live SignalOutcome
 * record is a different measurement (a close-to-close return over a fixed hold
 * with no stop) and is deliberately not mixed in here.
 */
const PHASE_4_PROVENANCE =
  'Phase 4, 2026-09-18: dataset 3fdeac9e, commit 30a56ef, entry 24 / exit 6 on the scorer before v5, ten symbols, six rolling windows, standard fees, slippage and funding';

const V7_PROVENANCE =
  'Session 17 audit, 2026-09-26: dataset e84cd66dbe01, image from 164a192, entry 29 / exit 7.25 under configVersion 7, ten symbols, lockbox on, standard fees, slippage and funding';

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
    verdict: 'Lost after costs on an earlier version of the rule; not re-measured under v7.',
    configVersion: null,
  },
  '15m': {
    interval: '15m',
    status: 'current',
    label: 'v7 control, 2026-09-26',
    provenance: V7_PROVENANCE,
    thresholds: { entry: 29, exit: 7.25 },
    trades: 4796,
    expectancyPercent: -0.1175,
    ciLowPercent: -0.174,
    ciHighPercent: -0.0583,
    medianHoldBars: 7,
    verdict: 'Loses after costs: the whole 95% interval is below zero.',
    configVersion: 7,
  },
  '1h': {
    interval: '1h',
    status: 'current',
    label: 'v7 control, 2026-09-26',
    provenance: V7_PROVENANCE,
    thresholds: { entry: 29, exit: 7.25 },
    trades: 8436,
    expectancyPercent: -0.0687,
    ciLowPercent: -0.1741,
    ciHighPercent: 0.0385,
    medianHoldBars: 7,
    verdict: 'Negative estimate after costs; the interval spans zero, so it is not shown to beat breakeven either.',
    configVersion: 7,
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
    verdict: 'Lost over 1% per trade on an earlier version of the rule, on a small sample.',
    configVersion: null,
  },
};

export function evidenceFor(interval: string): ControlEvidence {
  return (
    CONTROL_EVIDENCE[interval] ?? {
      interval,
      status: 'none',
      label: 'No research record',
      provenance: `The composite control was never measured at ${interval}.`,
      thresholds: null,
      trades: null,
      expectancyPercent: null,
      ciLowPercent: null,
      ciHighPercent: null,
      medianHoldBars: null,
      verdict: `Unmeasured: nothing in the record supports or rejects this rule at ${interval}.`,
      configVersion: null,
    }
  );
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
