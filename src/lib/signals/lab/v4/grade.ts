import type { LabScoreFields } from '@/lib/models/lab-score';
import {
  LAB_HYPOTHESES_V4,
  LAB_V4_HOLD_MS,
  LAB_V4_ROUND_TRIP,
  LAB_V4_THRESHOLD,
  labDelayMs,
  type LabHypothesis,
} from '@/lib/signals/lab/candidates';
import {
  stepEProcess,
  type EProcessState,
} from '@/lib/signals/lab/e-process';
import { LAB_GRADE_SETTLE_MS } from '@/lib/signals/lab/job-grade';

export function gradeDueAtV4(barClose: number): number {
  return barClose + labDelayMs('1h') + LAB_V4_HOLD_MS + LAB_GRADE_SETTLE_MS;
}

export function priceTimesV4(barClose: number): { start: number; end: number } {
  const start = barClose + labDelayMs('1h');
  const end = start + LAB_V4_HOLD_MS;
  return { start, end };
}

function isValidPrice(p: { start: number; end: number } | undefined): boolean {
  return (
    p !== undefined &&
    Number.isFinite(p.start) &&
    p.start > 0 &&
    Number.isFinite(p.end) &&
    p.end > 0
  );
}

export interface TradeGradeInput {
  hypothesis: Pick<LabHypothesis, 'id'> & Partial<LabHypothesis>;
  barClose: number;
  late: boolean;
  scores: Record<string, number>;
  /** Per symbol, the open of the perp 5m klines opening at start (T + D) and end (T + D + 8h). */
  prices: Record<string, { start: number; end: number }>;
  fundingSums?: Record<string, number>;
  funding?: Record<string, number>;
  prev: {
    state: EProcessState;
    weights?: Record<string, number> | null;
  };
  gradedAt: Date;
}

/** Pure: grades one lab-v4 trade metric bar. Never reads anything but its input. */
export function gradeTradeBar(input: TradeGradeInput): LabScoreFields {
  const hyp = LAB_HYPOTHESES_V4.find((h) => h.id === input.hypothesis.id);
  const scale = input.hypothesis.scale ?? hyp?.scale;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Invalid or missing scale: ${String(scale)}`);
  }

  const fundingSums = input.fundingSums ?? input.funding ?? {};

  const sideCoins = Object.keys(input.scores)
    .filter((sym) => input.scores[sym] !== 0 && Number.isFinite(input.scores[sym]))
    .sort();

  if (sideCoins.length === 0) {
    return {
      version: 'lab-v4',
      hypothesis: input.hypothesis.id,
      barClose: input.barClose,
      gradedAt: input.gradedAt,
      n: 0,
      x: null,
      b: null,
      turnover: null,
      kN: null,
      s: null,
      sHat: null,
      lambda: 0,
      lambda0: 0,
      bet: false,
      noBetReason: input.prev.state.absorbed ? 'absorbed' : 'no_position',
      weights: {},
      netBookReturn: null,
      prices: {},
      funding: {},
      state: { ...input.prev.state },
    };
  }

  const weights: Record<string, number> = {};
  for (const sym of sideCoins) {
    weights[sym] = input.scores[sym];
  }

  const pricedSideCoins = sideCoins.filter((sym) => isValidPrice(input.prices[sym]));

  const prices: Record<string, { start: number; end: number }> = {};
  const funding: Record<string, number> = {};
  for (const sym of pricedSideCoins) {
    prices[sym] = {
      start: input.prices[sym].start,
      end: input.prices[sym].end,
    };
    const fVal = fundingSums[sym];
    if (typeof fVal !== 'number' || !Number.isFinite(fVal)) {
      throw new Error(`Missing funding for priced coin: ${sym}`);
    }
    funding[sym] = fVal;
  }

  if (pricedSideCoins.length === 0) {
    return {
      version: 'lab-v4',
      hypothesis: input.hypothesis.id,
      barClose: input.barClose,
      gradedAt: input.gradedAt,
      n: 0,
      x: null,
      b: null,
      turnover: null,
      kN: null,
      s: null,
      sHat: null,
      lambda: 0,
      lambda0: 0,
      bet: false,
      noBetReason: input.prev.state.absorbed ? 'absorbed' : 'no_position',
      weights,
      netBookReturn: null,
      prices,
      funding,
      state: { ...input.prev.state },
    };
  }

  let R = 0;
  for (const sym of pricedSideCoins) {
    const side_i = input.scores[sym];
    const r_i = input.prices[sym].end / input.prices[sym].start - 1;
    const f_i = funding[sym];
    R += side_i * (r_i - f_i) - LAB_V4_ROUND_TRIP;
  }

  const x = Math.min(R / scale, 1);

  if (input.late) {
    return {
      version: 'lab-v4',
      hypothesis: input.hypothesis.id,
      barClose: input.barClose,
      gradedAt: input.gradedAt,
      n: pricedSideCoins.length,
      x,
      b: 0,
      turnover: null,
      kN: null,
      s: null,
      sHat: null,
      lambda: 0,
      lambda0: 0,
      bet: false,
      noBetReason: input.prev.state.absorbed ? 'absorbed' : 'late',
      weights,
      netBookReturn: R,
      prices,
      funding,
      state: { ...input.prev.state },
    };
  }

  const step = stepEProcess(
    input.prev.state,
    { barTime: input.barClose, x, b: 0 },
    { threshold: LAB_V4_THRESHOLD, lossUnbounded: true }
  );

  return {
    version: 'lab-v4',
    hypothesis: input.hypothesis.id,
    barClose: input.barClose,
    gradedAt: input.gradedAt,
    n: pricedSideCoins.length,
    x,
    b: 0,
    turnover: null,
    kN: null,
    s: null,
    sHat: null,
    lambda: step.lambda,
    lambda0: step.lambda0,
    bet: step.bet,
    noBetReason: step.bet
      ? null
      : input.prev.state.absorbed
      ? 'absorbed'
      : 'degenerate',
    weights,
    netBookReturn: R,
    prices,
    funding,
    state: step.state,
  };
}
