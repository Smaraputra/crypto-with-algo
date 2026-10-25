/**
 * Forward signal lab grading jobs (lab-v1, lab-v2, and lab-v3).
 *
 * Lab-v3 grades in its own pass:
 * Lab-v3 (hypothesis F1-1d) runs in a separate pass after lab-v1 and lab-v2 so that
 * lab-v3 venue calls (such as sequential kline fetches and exchangeInfo) and delisted coins
 * cannot stop or delay lab-v1 or lab-v2 grading, and lab-v1/v2 stopping early cannot prevent
 * lab-v3 from grading.
 *
 * The order rule:
 * Bars are graded strictly in bar-close order per hypothesis.
 * Each graded row writes its e-process state, which becomes the starting state
 * for the next bar of that hypothesis.
 *
 * Why a fetch failure grades nothing:
 * Rows written to labscores are permanent and write-once.
 * If any venue REST fetch throws an error during price retrieval,
 * the run grades nothing and returns success false.
 * A transient network failure must not freeze a bar as permanently unpriced.
 *
 * Why weights and s are kept for no-bet bars:
 * Even when a bar places no bet (due to late write, degenerate cross-section,
 * or missing hurdle), book weights and return standard deviation s are still
 * stored whenever at least 8 coins are priced.
 * The dollar-neutral book follows the forecast on every bar it can be priced,
 * and the trailing hurdle sHat requires recent cross-sectional volatility
 * from earlier bars.
 *
 * Immutability:
 * Nothing in this module can modify or delete a row once written.
 * Writes use insertLabScoreOnce with $setOnInsert upserts, guaranteeing that
 * concurrent or repeated grading runs cannot overwrite existing records.
 *
 * Max span per run:
 * A run grades due bars spanning at most LAB_GRADE_MAX_SPAN_MS per hypothesis
 * to respect venue kline range limits, leaving remaining bars to later runs.
 */

import {
  BinanceHttpError,
  fetchPerpExchangeInfo,
  fetchPerpKlinesRange,
  type PerpKline,
} from '@/lib/binance-futures';
import { syncFundingSettlements } from '@/lib/funding-settlement-sync';
import { FundingSettlement } from '@/lib/models/funding-settlement';
import {
  insertLabScoreOnce,
  LabScore,
  type LabNoBetReason,
  type LabScoreFields,
} from '@/lib/models/lab-score';
import { LabSignal, type ILabSignal } from '@/lib/models/lab-signal';
import { connectDB } from '@/lib/mongodb';
import {
  LAB_HYPOTHESES_V1,
  LAB_HYPOTHESES_V2,
  LAB_HYPOTHESES_V3,
  LAB_MIN_CROSS_SECTION,
  LAB_TIMEFRAME_MS,
  LAB_V2_THRESHOLD,
  LAB_V3_COST_PER_SIDE,
  LAB_V3_COST_UNRANKED,
  LAB_V3_DELISTING_HAIRCUT,
  LAB_V3_THRESHOLD,
  LAB_VERSION,
  LAB_VERSION_V2,
  LAB_VERSION_V3,
  labDelayMs,
  type LabHypothesis,
  type LabTimeframeAny,
} from '@/lib/signals/lab/candidates';
import {
  eValue,
  initialEState,
  stepEProcess,
  type EProcessState,
} from '@/lib/signals/lab/e-process';
import {
  bookTurnover,
  hurdle,
  LAB_COST_PER_SIDE,
  LAB_S_WINDOW,
  trailingS,
} from '@/lib/signals/lab/hurdle';
import { N2 } from '@/lib/signals/lab/v2/n2';
import { N3 } from '@/lib/signals/lab/v2/n3';
import {
  bookReturn,
  bookWeights,
  kN,
  populationSd,
  rankWeightedCorrelation,
} from '@/lib/stats/rank-ic';

/** Below this cross-sectional return SD a bar is degenerate (lock: GATES). */
export const LAB_MIN_RETURN_SD = 1e-9;
/** Grading waits for the end kline (opening at T + D + Δ) to close. */
export const LAB_GRADE_SETTLE_MS = 5 * 60_000;
/** Maximum time span of due bars graded in a single run per hypothesis. */
export const LAB_GRADE_MAX_SPAN_MS = 40 * 86_400_000;

export function gradeDueAt(barClose: number, tf: LabTimeframeAny): number {
  return barClose + labDelayMs(tf) + LAB_TIMEFRAME_MS[tf] + LAB_GRADE_SETTLE_MS;
}

export function priceTimes(barClose: number, tf: LabTimeframeAny): { start: number; end: number } {
  const start = barClose + labDelayMs(tf);
  const end = start + LAB_TIMEFRAME_MS[tf];
  return { start, end };
}

export interface GradeInput {
  hypothesis: string;
  barClose: number;
  late: boolean;
  scores: Record<string, number>;
  /** Per symbol, the open of the perp 5m klines opening at T + D and T + D + Δ. A symbol is absent when either is missing. */
  prices: Record<string, { start: number; end: number }>;
  prev: {
    state: EProcessState;
    /** Weights of the previous graded bar with at least 8 priced coins, null before the first. */
    weights: Record<string, number> | null;
    /** s of earlier graded bars with at least 8 priced coins, oldest first (the caller passes at most LAB_S_WINDOW). */
    pastS: number[];
  };
  gradedAt: Date;
}

/** Pure: grades one bar. Never reads anything but its input. */
export function gradeBar(input: GradeInput): LabScoreFields {
  const scoredCoins = Object.keys(input.scores)
    .filter((sym) => Number.isFinite(input.scores[sym]))
    .sort();

  const pricedCoins = scoredCoins
    .filter((sym) => {
      const p = input.prices[sym];
      return (
        p !== undefined &&
        Number.isFinite(p.start) &&
        p.start > 0 &&
        Number.isFinite(p.end) &&
        p.end > 0
      );
    })
    .sort();

  const n = pricedCoins.length;

  const prices: Record<string, { start: number; end: number }> = {};
  for (const sym of pricedCoins) {
    prices[sym] = {
      start: input.prices[sym].start,
      end: input.prices[sym].end,
    };
  }

  if (n < LAB_MIN_CROSS_SECTION) {
    return {
      version: LAB_VERSION,
      hypothesis: input.hypothesis,
      barClose: input.barClose,
      gradedAt: input.gradedAt,
      n,
      x: null,
      b: null,
      turnover: null,
      kN: null,
      s: null,
      sHat: null,
      lambda: 0,
      lambda0: 0,
      bet: false,
      noBetReason: 'cross_section',
      weights: null,
      netBookReturn: null,
      prices,
      state: { ...input.prev.state },
    };
  }

  const scoredScores = scoredCoins.map((sym) => input.scores[sym]);
  const weightsArr = bookWeights(scoredScores);
  const weights: Record<string, number> = {};
  for (let i = 0; i < scoredCoins.length; i++) {
    weights[scoredCoins[i]] = weightsArr[i];
  }

  const turnover = bookTurnover(input.prev.weights, weights);
  const kNVal = kN(scoredScores);

  const pricedScores = pricedCoins.map((sym) => input.scores[sym]);
  const pricedReturns = pricedCoins.map(
    (sym) => input.prices[sym].end / input.prices[sym].start - 1
  );

  const rawX = rankWeightedCorrelation(pricedScores, pricedReturns);
  const s = populationSd(pricedReturns);
  const sHat = trailingS(input.prev.pastS, LAB_S_WINDOW);
  const b = hurdle({ turnover, kN: kNVal, sHat });
  const netBookReturn =
    bookReturn(pricedScores, pricedReturns) - turnover * LAB_COST_PER_SIDE;

  let noBetReason: LabNoBetReason | null = null;
  let x: number | null = rawX;

  if (input.late) {
    noBetReason = 'late';
    if (!Number.isFinite(rawX)) {
      x = null;
    }
  } else if (s < LAB_MIN_RETURN_SD || !Number.isFinite(rawX)) {
    noBetReason = 'degenerate';
    x = null;
  } else if (b === null) {
    noBetReason = 'no_hurdle';
  }

  if (noBetReason !== null) {
    return {
      version: LAB_VERSION,
      hypothesis: input.hypothesis,
      barClose: input.barClose,
      gradedAt: input.gradedAt,
      n,
      x,
      b,
      turnover,
      kN: kNVal,
      s,
      sHat,
      lambda: 0,
      lambda0: 0,
      bet: false,
      noBetReason,
      weights,
      netBookReturn,
      prices,
      state: { ...input.prev.state },
    };
  }

  const step = stepEProcess(input.prev.state, {
    barTime: input.barClose,
    x: x!,
    b: b!,
  });

  if (!step.bet) {
    return {
      version: LAB_VERSION,
      hypothesis: input.hypothesis,
      barClose: input.barClose,
      gradedAt: input.gradedAt,
      n,
      x: null,
      b,
      turnover,
      kN: kNVal,
      s,
      sHat,
      lambda: 0,
      lambda0: 0,
      bet: false,
      noBetReason: 'degenerate',
      weights,
      netBookReturn,
      prices,
      state: { ...input.prev.state },
    };
  }

  return {
    version: LAB_VERSION,
    hypothesis: input.hypothesis,
    barClose: input.barClose,
    gradedAt: input.gradedAt,
    n,
    x,
    b,
    turnover,
    kN: kNVal,
    s,
    sHat,
    lambda: step.lambda,
    lambda0: step.lambda0,
    bet: step.bet,
    noBetReason: null,
    weights,
    netBookReturn,
    prices,
    state: step.state,
  };
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

export interface BookGradeInput {
  hypothesis: Pick<LabHypothesis, 'id'> & Partial<LabHypothesis>;
  barClose: number;
  late: boolean;
  scores: Record<string, number>;
  /** Per symbol, the open of the perp 5m klines opening at T + D and T + D + Δ. */
  prices: Record<string, { start: number; end: number }>;
  fundingSums?: Record<string, number>;
  funding?: Record<string, number>;
  delisted?: string[];
  prev: {
    state: EProcessState;
    weights: Record<string, number> | null;
  };
  gradedAt: Date;
}

/** Pure: grades one lab-v2 / lab-v3 book metric bar. Never reads anything but its input. */
export function gradeBookBar(input: BookGradeInput): LabScoreFields {
  const candidate = input.hypothesis.candidate;
  if (candidate !== 'N2' && candidate !== 'N3' && candidate !== 'F1') {
    throw new Error(`Invalid or missing candidate: ${String(candidate)}`);
  }
  const scale = input.hypothesis.scale;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Invalid or missing scale: ${String(scale)}`);
  }
  const fundingSums = input.fundingSums ?? input.funding ?? {};
  const version = input.hypothesis.version ?? (candidate === 'F1' ? LAB_VERSION_V3 : LAB_VERSION_V2);

  if (candidate === 'F1') {
    const weights: Record<string, number> = {};
    for (const sym of Object.keys(input.scores).sort()) {
      const val = input.scores[sym];
      if (Number.isFinite(val)) {
        weights[sym] = val;
      }
    }

    const turnover = bookTurnover(input.prev.weights, weights);

    const prevWeights = input.prev.weights;
    const allCostSymbols = new Set<string>([
      ...Object.keys(weights),
      ...(prevWeights ? Object.keys(prevWeights) : []),
    ]);
    let cost = 0;
    for (const sym of allCostSymbols) {
      const wCurr = weights[sym] ?? 0;
      const wPrev = prevWeights ? (prevWeights[sym] ?? 0) : 0;
      const traded = Math.abs(wCurr - wPrev);
      if (traded > 0) {
        const costRate = LAB_V3_COST_PER_SIDE[sym] ?? LAB_V3_COST_UNRANKED;
        cost += traded * costRate;
      }
    }

    const weightedCoins = Object.keys(weights).filter((sym) => weights[sym] !== 0).sort();
    const pricedCoins = weightedCoins.filter((sym) => isValidPrice(input.prices[sym]));

    const prices: Record<string, { start: number; end: number }> = {};
    const funding: Record<string, number> = {};
    const delistedSet = new Set(input.delisted ?? []);

    let sumReturnFunding = 0;
    for (const sym of pricedCoins) {
      prices[sym] = {
        start: input.prices[sym].start,
        end: input.prices[sym].end,
      };
      const fVal = fundingSums[sym];
      if (typeof fVal !== 'number' || !Number.isFinite(fVal)) {
        throw new Error(`Missing funding for priced coin: ${sym}`);
      }
      funding[sym] = fVal;

      let r_i = input.prices[sym].end / input.prices[sym].start - 1;
      if (delistedSet.has(sym)) {
        r_i -= LAB_V3_DELISTING_HAIRCUT;
      }
      const funding_i = funding[sym];
      sumReturnFunding += weights[sym] * (r_i - funding_i);
    }

    const R = sumReturnFunding - cost;
    const x = Math.min(R / scale, 1);

    if (input.late) {
      return {
        version: LAB_VERSION_V3,
        hypothesis: input.hypothesis.id,
        barClose: input.barClose,
        gradedAt: input.gradedAt,
        n: pricedCoins.length,
        x,
        b: 0,
        turnover,
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
      { threshold: LAB_V3_THRESHOLD, lossUnbounded: true }
    );

    return {
      version: LAB_VERSION_V3,
      hypothesis: input.hypothesis.id,
      barClose: input.barClose,
      gradedAt: input.gradedAt,
      n: pricedCoins.length,
      x,
      b: 0,
      turnover,
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

  if (candidate === 'N2') {
    const weights: Record<string, number> = {};
    for (const sym of Object.keys(input.scores).sort()) {
      const val = input.scores[sym];
      if (Number.isFinite(val)) {
        weights[sym] = val;
      }
    }

    const weightedCoins = Object.keys(weights).filter((sym) => weights[sym] !== 0).sort();
    const pricedWeightedCoins = weightedCoins.filter((sym) => isValidPrice(input.prices[sym]));

    const prices: Record<string, { start: number; end: number }> = {};
    const funding: Record<string, number> = {};
    for (const sym of pricedWeightedCoins) {
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

    const turnover = bookTurnover(input.prev.weights, weights);

    if (pricedWeightedCoins.length < weightedCoins.length) {
      return {
        version,
        hypothesis: input.hypothesis.id,
        barClose: input.barClose,
        gradedAt: input.gradedAt,
        n: pricedWeightedCoins.length,
        x: null,
        b: null,
        turnover,
        kN: null,
        s: null,
        sHat: null,
        lambda: 0,
        lambda0: 0,
        bet: false,
        noBetReason: input.prev.state.absorbed ? 'absorbed' : 'cross_section',
        weights,
        netBookReturn: null,
        prices,
        funding,
        state: { ...input.prev.state },
      };
    }

    let sumReturnFunding = 0;
    for (const sym of weightedCoins) {
      const r_i = input.prices[sym].end / input.prices[sym].start - 1;
      const f_i = -funding[sym];
      sumReturnFunding += weights[sym] * (r_i + f_i);
    }

    const R = sumReturnFunding - N2.costRate * turnover;
    const x = Math.min(R / scale, 1);

    if (input.late) {
      return {
        version,
        hypothesis: input.hypothesis.id,
        barClose: input.barClose,
        gradedAt: input.gradedAt,
        n: weightedCoins.length,
        x,
        b: 0,
        turnover,
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
      { threshold: LAB_V2_THRESHOLD, lossUnbounded: true }
    );

    return {
      version,
      hypothesis: input.hypothesis.id,
      barClose: input.barClose,
      gradedAt: input.gradedAt,
      n: weightedCoins.length,
      x,
      b: 0,
      turnover,
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

  // Candidate N3
  const sideCoins = Object.keys(input.scores)
    .filter((sym) => input.scores[sym] !== 0 && Number.isFinite(input.scores[sym]))
    .sort();

  if (sideCoins.length === 0) {
    return {
      version,
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
      version,
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
    const f_i = -funding[sym];
    R += side_i * (r_i + f_i) - N3.costPerTrade;
  }

  const x = Math.min(R / scale, 1);

  if (input.late) {
    return {
      version,
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
    { threshold: LAB_V2_THRESHOLD, lossUnbounded: true }
  );

  return {
    version,
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

export interface FundingSumsResult {
  sums: Record<string, number>;
  coverage: Record<string, boolean>;
}

export async function defaultFundingSumsFor(
  symbols: string[],
  fromExclusive: number,
  toInclusive: number
): Promise<FundingSumsResult> {
  const settlements = (await FundingSettlement.find(
    {
      symbol: { $in: symbols },
      fundingTime: { $gt: fromExclusive, $lte: toInclusive },
    },
    { symbol: 1, rate: 1, fundingTime: 1 }
  ).lean()) as Array<{ symbol: string; rate: number; fundingTime: number }>;

  const eightHours = 8 * 60 * 60 * 1000;
  const coverageStart = toInclusive - eightHours;

  const sums: Record<string, number> = {};
  const coverage: Record<string, boolean> = {};

  for (const sym of symbols) {
    coverage[sym] = false;
  }

  for (const s of settlements) {
    if (Number.isFinite(s.rate)) {
      sums[s.symbol] = (sums[s.symbol] ?? 0) + s.rate;
    }
    if (s.fundingTime > coverageStart && s.fundingTime <= toInclusive) {
      coverage[s.symbol] = true;
    }
  }

  return { sums, coverage };
}

export function normalizeFundingSumsResult(
  raw: FundingSumsResult | Record<string, number>
): FundingSumsResult {
  if (raw && typeof raw === 'object' && 'sums' in raw && 'coverage' in raw) {
    return raw as FundingSumsResult;
  }
  const plain = (raw ?? {}) as Record<string, number>;
  const coverage: Record<string, boolean> = {};
  for (const sym of Object.keys(plain)) {
    coverage[sym] = Number.isFinite(plain[sym]);
  }
  return { sums: plain, coverage };
}

export interface LabGradeDeps {
  fetchPerpKlinesRange: typeof fetchPerpKlinesRange;
  fundingSumsFor?: (
    symbols: string[],
    fromExclusive: number,
    toInclusive: number
  ) => Promise<FundingSumsResult | Record<string, number>>;
  syncFundingSettlements?: (symbols: string[], now: number) => Promise<unknown>;
  fetchPerpExchangeInfo?: () => Promise<Array<{ symbol: string; status: string }>>;
  sleep?: (ms: number) => Promise<void>;
  clock: () => number;
}

export const defaultLabGradeDeps: LabGradeDeps = {
  fetchPerpKlinesRange,
  fundingSumsFor: defaultFundingSumsFor,
  syncFundingSettlements,
  fetchPerpExchangeInfo,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock: () => Date.now(),
};

export interface LabGradeReport {
  success: boolean;
  graded: {
    hypothesis: string;
    barClose: number;
    bet: boolean;
    x: number | null;
    b: number | null;
    e: number;
  }[];
  pending: {
    hypothesis: string;
    barClose: number;
    dueAt: number;
    reason?: string;
    error?: string;
    blockedBars?: number;
  }[];
  errors: string[];
}

async function gradeLabV1AndV2(
  now: number,
  d: LabGradeDeps,
  deps: LabGradeDeps | undefined,
  report: LabGradeReport
): Promise<void> {
  interface DueHypothesisInfo {
    hyp: (typeof LAB_HYPOTHESES_V1)[number];
    dueSignals: ILabSignal[];
    last: LabScoreFields | null;
  }

  const dueByHypothesis: DueHypothesisInfo[] = [];

  for (const hyp of LAB_HYPOTHESES_V1) {
    const last = (await LabScore.findOne({
      version: hyp.version,
      hypothesis: hyp.id,
    })
      .sort({ barClose: -1 })
      .lean()) as LabScoreFields | null;

    const minBarClose = last?.barClose ?? -1;
    const signals = (await LabSignal.find({
      version: hyp.version,
      hypothesis: hyp.id,
      barClose: { $gt: minBarClose },
    })
      .sort({ barClose: 1 })
      .lean()) as ILabSignal[];

    const dueSignals: ILabSignal[] = [];
    for (const sig of signals) {
      const dueAt = gradeDueAt(sig.barClose, hyp.timeframe);
      if (now < dueAt) {
        report.pending.push({
          hypothesis: hyp.id,
          barClose: sig.barClose,
          dueAt,
        });
        break;
      }
      if (
        dueSignals.length > 0 &&
        sig.barClose - dueSignals[0].barClose > LAB_GRADE_MAX_SPAN_MS
      ) {
        break;
      }
      dueSignals.push(sig);
    }

    if (dueSignals.length > 0) {
      dueByHypothesis.push({ hyp, dueSignals, last });
    }
  }

  if (dueByHypothesis.length > 0) {
    const neededTimesBySymbol = new Map<string, Set<number>>();
    for (const { hyp, dueSignals } of dueByHypothesis) {
      for (const sig of dueSignals) {
        const { start, end } = priceTimes(sig.barClose, hyp.timeframe);
        for (const sym of Object.keys(sig.scores)) {
          let set = neededTimesBySymbol.get(sym);
          if (!set) {
            set = new Set<number>();
            neededTimesBySymbol.set(sym, set);
          }
          set.add(start);
          set.add(end);
        }
      }
    }

    const symbols = Array.from(neededTimesBySymbol.keys()).sort();
    const priceMapBySymbol = new Map<string, Map<number, number>>();
    const failedSymbols = new Map<string, string>();

    if (symbols.length > 0) {
      const fetchResults = await Promise.allSettled(
        symbols.map(async (sym) => {
          const timesSet = neededTimesBySymbol.get(sym);
          const times = timesSet ? Array.from(timesSet) : [];
          const minNeeded = Math.min(...times);
          const maxNeeded = Math.max(...times);
          const klines = await d.fetchPerpKlinesRange(sym, '5m', minNeeded, maxNeeded);
          return { sym, klines };
        })
      );

      for (let i = 0; i < symbols.length; i++) {
        const res = fetchResults[i];
        const sym = symbols[i];
        if (res.status === 'rejected') {
          const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
          failedSymbols.set(sym, msg);
          report.errors.push(msg);
        } else {
          const { klines } = res.value;
          const klineMap = new Map<number, number>();
          for (const k of klines) {
            klineMap.set(k.openTime, k.open);
          }
          priceMapBySymbol.set(sym, klineMap);
        }
      }

      if (failedSymbols.size > 0) {
        report.success = false;
      }
    }

    for (const { hyp, dueSignals, last } of dueByHypothesis) {
      const latestWithWeights = (await LabScore.findOne({
        version: hyp.version,
        hypothesis: hyp.id,
        weights: { $ne: null },
      })
        .sort({ barClose: -1 })
        .lean()) as LabScoreFields | null;

      const sDocs = (await LabScore.find(
        {
          version: hyp.version,
          hypothesis: hyp.id,
          s: { $ne: null },
        },
        { s: 1 }
      )
        .sort({ barClose: -1 })
        .limit(LAB_S_WINDOW)
        .lean()) as Pick<LabScoreFields, 's'>[];

      const pastS = sDocs.map((doc) => doc.s as number).reverse();

      const prev = {
        state: last?.state ? { ...last.state } : initialEState(),
        weights: latestWithWeights?.weights ?? null,
        pastS,
      };

      for (let i = 0; i < dueSignals.length; i++) {
        const sig = dueSignals[i];
        const failedCoins = Object.keys(sig.scores)
          .filter((sym) => failedSymbols.has(sym))
          .sort();

        if (failedCoins.length > 0) {
          const failedSym = failedCoins[0];
          const errorMsg = failedSymbols.get(failedSym);
          report.pending.push({
            hypothesis: hyp.id,
            barClose: sig.barClose,
            dueAt: gradeDueAt(sig.barClose, hyp.timeframe),
            reason: 'price_fetch_failed',
            blockedBars: dueSignals.length - i,
            ...(errorMsg !== undefined ? { error: errorMsg } : {}),
          });
          break;
        }
        const { start, end } = priceTimes(sig.barClose, hyp.timeframe);
        const prices: Record<string, { start: number; end: number }> = {};
        for (const sym of Object.keys(sig.scores)) {
          const klineMap = priceMapBySymbol.get(sym);
          if (klineMap) {
            const startPrice = klineMap.get(start);
            const endPrice = klineMap.get(end);
            if (startPrice !== undefined && endPrice !== undefined) {
              prices[sym] = { start: startPrice, end: endPrice };
            }
          }
        }

        const input: GradeInput = {
          hypothesis: hyp.id,
          barClose: sig.barClose,
          late: sig.late,
          scores: sig.scores,
          prices,
          prev: {
            state: prev.state,
            weights: prev.weights,
            pastS: [...prev.pastS],
          },
          gradedAt: new Date(d.clock()),
        };

        const row = gradeBar(input);

        const { inserted } = await insertLabScoreOnce(row);
        if (!inserted) {
          break;
        }

        prev.state = row.state;
        if (row.weights !== null) {
          prev.weights = row.weights;
        }
        if (row.s !== null) {
          prev.pastS.push(row.s);
          if (prev.pastS.length > LAB_S_WINDOW) {
            prev.pastS.shift();
          }
        }

        report.graded.push({
          hypothesis: hyp.id,
          barClose: sig.barClose,
          bet: row.bet,
          x: row.x,
          b: row.b,
          e: eValue(row.state),
        });
      }
    }
  }

  // Lab-v2 grading
  interface DueV2HypothesisInfo {
    hyp: (typeof LAB_HYPOTHESES_V2)[number];
    dueSignals: ILabSignal[];
    last: LabScoreFields | null;
  }

  const dueV2ByHypothesis: DueV2HypothesisInfo[] = [];

  for (const hyp of LAB_HYPOTHESES_V2) {
    const last = (await LabScore.findOne({
      version: hyp.version,
      hypothesis: hyp.id,
    })
      .sort({ barClose: -1 })
      .lean()) as LabScoreFields | null;

    const minBarClose = last?.barClose ?? -1;
    const signals = (await LabSignal.find({
      version: hyp.version,
      hypothesis: hyp.id,
      barClose: { $gt: minBarClose },
    })
      .sort({ barClose: 1 })
      .lean()) as ILabSignal[];

    const dueSignals: ILabSignal[] = [];
    for (const sig of signals) {
      const dueAt = gradeDueAt(sig.barClose, hyp.timeframe);
      if (now < dueAt) {
        report.pending.push({
          hypothesis: hyp.id,
          barClose: sig.barClose,
          dueAt,
        });
        break;
      }
      if (
        dueSignals.length > 0 &&
        sig.barClose - dueSignals[0].barClose > LAB_GRADE_MAX_SPAN_MS
      ) {
        break;
      }
      dueSignals.push(sig);
    }

    if (dueSignals.length > 0) {
      dueV2ByHypothesis.push({ hyp, dueSignals, last });
    }
  }

  if (dueV2ByHypothesis.length === 0) {
    return;
  }

  const neededTimesBySymbolV2 = new Map<string, Set<number>>();
  for (const { hyp, dueSignals } of dueV2ByHypothesis) {
    for (const sig of dueSignals) {
      const { start, end } = priceTimes(sig.barClose, hyp.timeframe);
      for (const sym of Object.keys(sig.scores)) {
        let set = neededTimesBySymbolV2.get(sym);
        if (!set) {
          set = new Set<number>();
          neededTimesBySymbolV2.set(sym, set);
        }
        set.add(start);
        set.add(end);
      }
    }
  }

  const symbolsV2 = Array.from(neededTimesBySymbolV2.keys()).sort();
  const priceMapBySymbolV2 = new Map<string, Map<number, number>>();

  if (symbolsV2.length > 0) {
    const fetchResults = await Promise.allSettled(
      symbolsV2.map(async (sym) => {
        const times = Array.from(neededTimesBySymbolV2.get(sym)!);
        const minNeeded = Math.min(...times);
        const maxNeeded = Math.max(...times);
        const klines = await d.fetchPerpKlinesRange(sym, '5m', minNeeded, maxNeeded);
        return { sym, klines };
      })
    );

    let anyFailed = false;
    for (const res of fetchResults) {
      if (res.status === 'rejected') {
        anyFailed = true;
        const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
        report.errors.push(msg);
      } else {
        const { sym, klines } = res.value;
        const klineMap = new Map<number, number>();
        for (const k of klines) {
          klineMap.set(k.openTime, k.open);
        }
        priceMapBySymbolV2.set(sym, klineMap);
      }
    }

    if (anyFailed) {
      report.success = false;
      return;
    }
  }

  const syncErrorsBySymbol = new Map<string, string>();
  const shouldSyncFunding =
    symbolsV2.length > 0 &&
    (deps?.syncFundingSettlements !== undefined || !deps?.fundingSumsFor) &&
    Boolean(d.syncFundingSettlements);

  if (shouldSyncFunding && d.syncFundingSettlements) {
    try {
      const syncResults = await d.syncFundingSettlements(symbolsV2, now);
      if (Array.isArray(syncResults)) {
        for (const res of syncResults) {
          if (res && typeof res === 'object' && 'symbol' in res && res.error) {
            syncErrorsBySymbol.set(res.symbol, res.error);
            report.errors.push(`Funding sync error for ${res.symbol}: ${res.error}`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(msg);
      for (const sym of symbolsV2) {
        syncErrorsBySymbol.set(sym, msg);
      }
    }
  }

  const fundingSumsFor = d.fundingSumsFor ?? defaultFundingSumsFor;

  for (const { hyp, dueSignals, last } of dueV2ByHypothesis) {
    const prev = {
      state: last?.state ? { ...last.state } : initialEState(),
      weights: last?.weights ?? null,
    };

    for (const sig of dueSignals) {
      const { start, end } = priceTimes(sig.barClose, hyp.timeframe);
      const prices: Record<string, { start: number; end: number }> = {};
      const symbolsInScores = Object.keys(sig.scores);

      for (const sym of symbolsInScores) {
        const klineMap = priceMapBySymbolV2.get(sym);
        if (klineMap) {
          const startPrice = klineMap.get(start);
          const endPrice = klineMap.get(end);
          if (startPrice !== undefined && endPrice !== undefined) {
            prices[sym] = { start: startPrice, end: endPrice };
          }
        }
      }

      const candidate = hyp.candidate;
      let relevantCoins: string[] = [];
      let pricedCoins: string[] = [];

      if (candidate === 'N2') {
        const weights: Record<string, number> = {};
        for (const sym of symbolsInScores) {
          const val = sig.scores[sym];
          if (Number.isFinite(val) && val !== 0) {
            weights[sym] = val;
          }
        }
        relevantCoins = Object.keys(weights).sort();
        pricedCoins = relevantCoins.filter((sym) => isValidPrice(prices[sym]));
      } else if (candidate === 'N3') {
        relevantCoins = symbolsInScores
          .filter((sym) => sig.scores[sym] !== 0 && Number.isFinite(sig.scores[sym]))
          .sort();
        pricedCoins = relevantCoins.filter((sym) => isValidPrice(prices[sym]));
      }

      const hasSyncError = relevantCoins.some((sym) => syncErrorsBySymbol.has(sym));
      if (hasSyncError) {
        report.pending.push({
          hypothesis: hyp.id,
          barClose: sig.barClose,
          dueAt: gradeDueAt(sig.barClose, hyp.timeframe),
        });
        break;
      }

      let fundingSums: Record<string, number> = {};
      if (pricedCoins.length > 0) {
        let fundingRaw: FundingSumsResult | Record<string, number>;
        try {
          fundingRaw = await fundingSumsFor(pricedCoins, start, end);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          report.errors.push(msg);
          report.pending.push({
            hypothesis: hyp.id,
            barClose: sig.barClose,
            dueAt: gradeDueAt(sig.barClose, hyp.timeframe),
          });
          break;
        }

        const norm = normalizeFundingSumsResult(fundingRaw);
        fundingSums = norm.sums;

        const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
        let coverageMissing = false;
        for (const sym of pricedCoins) {
          if (!norm.coverage[sym]) {
            coverageMissing = true;
            if (now > end + FORTY_EIGHT_HOURS) {
              report.errors.push(
                `Funding coverage gap older than 48 hours for ${sym} at windowEnd ${end} in hypothesis ${hyp.id}`
              );
            }
          }
        }

        if (coverageMissing) {
          report.pending.push({
            hypothesis: hyp.id,
            barClose: sig.barClose,
            dueAt: gradeDueAt(sig.barClose, hyp.timeframe),
          });
          break;
        }
      }

      const input: BookGradeInput = {
        hypothesis: hyp,
        barClose: sig.barClose,
        late: sig.late,
        scores: sig.scores,
        prices,
        fundingSums,
        prev: {
          state: prev.state,
          weights: prev.weights,
        },
        gradedAt: new Date(d.clock()),
      };

      const row = gradeBookBar(input);

      const { inserted } = await insertLabScoreOnce(row);
      if (!inserted) {
        break;
      }

      prev.state = row.state;
      prev.weights = row.weights;

      report.graded.push({
        hypothesis: hyp.id,
        barClose: sig.barClose,
        bet: row.bet,
        x: row.x,
        b: row.b,
        e: eValue(row.state),
      });
    }
  }
}

async function gradeLabV3(
  now: number,
  d: LabGradeDeps,
  deps: LabGradeDeps | undefined,
  report: LabGradeReport
): Promise<void> {
  interface DueV3HypothesisInfo {
    hyp: (typeof LAB_HYPOTHESES_V3)[number];
    dueSignals: ILabSignal[];
    last: LabScoreFields | null;
  }

  const dueV3ByHypothesis: DueV3HypothesisInfo[] = [];

  for (const hyp of LAB_HYPOTHESES_V3) {
    const last = (await LabScore.findOne({
      version: hyp.version,
      hypothesis: hyp.id,
    })
      .sort({ barClose: -1 })
      .lean()) as LabScoreFields | null;

    const minBarClose = last?.barClose ?? -1;
    const signals = (await LabSignal.find({
      version: hyp.version,
      hypothesis: hyp.id,
      barClose: { $gt: minBarClose },
    })
      .sort({ barClose: 1 })
      .lean()) as ILabSignal[];

    const dueSignals: ILabSignal[] = [];
    for (const sig of signals) {
      const dueAt = gradeDueAt(sig.barClose, hyp.timeframe);
      if (now < dueAt) {
        report.pending.push({
          hypothesis: hyp.id,
          barClose: sig.barClose,
          dueAt,
        });
        break;
      }
      if (
        dueSignals.length > 0 &&
        sig.barClose - dueSignals[0].barClose > LAB_GRADE_MAX_SPAN_MS
      ) {
        break;
      }
      dueSignals.push(sig);
    }

    if (dueSignals.length > 0) {
      dueV3ByHypothesis.push({ hyp, dueSignals, last });
    }
  }

  if (dueV3ByHypothesis.length === 0) {
    return;
  }

  const fetchExchangeInfo = d.fetchPerpExchangeInfo ?? defaultLabGradeDeps.fetchPerpExchangeInfo!;
  let exchangeInfoSymbols: Array<{ symbol: string; status: string }>;
  try {
    exchangeInfoSymbols = await fetchExchangeInfo();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(msg);
    report.success = false;
    return;
  }

  const trading = new Set<string>();
  for (const s of exchangeInfoSymbols) {
    if (s.status === 'TRADING') {
      trading.add(s.symbol);
    }
  }

  const neededTimesBySymbolV3 = new Map<string, Set<number>>();
  for (const { hyp, dueSignals } of dueV3ByHypothesis) {
    for (const sig of dueSignals) {
      const { start, end } = priceTimes(sig.barClose, hyp.timeframe);
      for (const sym of Object.keys(sig.scores)) {
        let set = neededTimesBySymbolV3.get(sym);
        if (!set) {
          set = new Set<number>();
          neededTimesBySymbolV3.set(sym, set);
        }
        set.add(start);
        set.add(end);
      }
    }
  }

  const symbolsV3 = Array.from(neededTimesBySymbolV3.keys()).sort();
  const priceMapBySymbolV3 = new Map<string, Map<number, number>>();
  const klinesBySymbolV3 = new Map<string, PerpKline[]>();
  const sleep = d.sleep ?? defaultLabGradeDeps.sleep!;

  for (let i = 0; i < symbolsV3.length; i++) {
    if (i > 0) {
      await sleep(250);
    }
    const sym = symbolsV3[i];
    const times = Array.from(neededTimesBySymbolV3.get(sym)!);
    const minNeeded = Math.min(...times);
    const maxNeeded = Math.max(...times);

    let klines: PerpKline[];
    try {
      klines = await d.fetchPerpKlinesRange(sym, '5m', minNeeded, maxNeeded);
    } catch (err) {
      if (err instanceof BinanceHttpError && err.status === 400) {
        report.errors.push(err.message);
        klines = [];
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        report.errors.push(msg);
        report.success = false;
        return;
      }
    }

    klinesBySymbolV3.set(sym, klines);
    const klineMap = new Map<number, number>();
    for (const k of klines) {
      klineMap.set(k.openTime, k.open);
    }
    priceMapBySymbolV3.set(sym, klineMap);
  }

  const syncErrorsBySymbol = new Map<string, string>();
  const shouldSyncFunding =
    symbolsV3.length > 0 &&
    (deps?.syncFundingSettlements !== undefined || !deps?.fundingSumsFor) &&
    Boolean(d.syncFundingSettlements);

  if (shouldSyncFunding && d.syncFundingSettlements) {
    try {
      const syncResults = await d.syncFundingSettlements(symbolsV3, now);
      if (Array.isArray(syncResults)) {
        for (const res of syncResults) {
          if (res && typeof res === 'object' && 'symbol' in res && res.error) {
            syncErrorsBySymbol.set(res.symbol, res.error);
            report.errors.push(`Funding sync error for ${res.symbol}: ${res.error}`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(msg);
      for (const sym of symbolsV3) {
        syncErrorsBySymbol.set(sym, msg);
      }
    }
  }

  const fundingSumsFor = d.fundingSumsFor ?? defaultFundingSumsFor;

  for (const { hyp, dueSignals, last } of dueV3ByHypothesis) {
    const prev = {
      state: last?.state ? { ...last.state } : initialEState(),
      weights: last?.weights ?? null,
    };

    for (const sig of dueSignals) {
      const { start, end } = priceTimes(sig.barClose, hyp.timeframe);
      const prices: Record<string, { start: number; end: number }> = {};
      const normalCoins: string[] = [];
      const delistedCoins: string[] = [];

      for (const sym of Object.keys(sig.scores).sort()) {
        const val = sig.scores[sym];
        if (!Number.isFinite(val) || val === 0) continue;

        const klineMap = priceMapBySymbolV3.get(sym);
        const hasStart = klineMap ? klineMap.has(start) : false;
        const hasEnd = klineMap ? klineMap.has(end) : false;

        if (!hasStart) {
          // a. no kline opening at start -> unpriced (omitted from prices, contributes 0)
          continue;
        }

        if (hasEnd) {
          // b. klines opening at start and end -> normal
          normalCoins.push(sym);
          prices[sym] = { start: klineMap!.get(start)!, end: klineMap!.get(end)! };
        } else if (trading.has(sym)) {
          // c. kline at start, none at end, symbol in trading -> unpriced (venue gap, contributes 0)
          continue;
        } else {
          // d. kline at start, none at end, symbol NOT in trading -> delisted
          const klines = klinesBySymbolV3.get(sym) ?? [];
          const inWindow = klines.filter((k) => k.openTime >= start && k.openTime < end);
          if (inWindow.length > 0) {
            const lastKline = inWindow[inWindow.length - 1];
            prices[sym] = { start: klineMap!.get(start)!, end: lastKline.close };
            delistedCoins.push(sym);
          }
        }
      }

      const hasNormalSyncError = normalCoins.some((sym) => syncErrorsBySymbol.has(sym));
      if (hasNormalSyncError) {
        report.pending.push({
          hypothesis: hyp.id,
          barClose: sig.barClose,
          dueAt: gradeDueAt(sig.barClose, hyp.timeframe),
        });
        break;
      }

      const pricedCoins = [...normalCoins, ...delistedCoins].sort();
      let fundingSums: Record<string, number> = {};

      if (pricedCoins.length > 0) {
        let fundingRaw: FundingSumsResult | Record<string, number>;
        try {
          fundingRaw = await fundingSumsFor(pricedCoins, start, end);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          report.errors.push(msg);
          report.pending.push({
            hypothesis: hyp.id,
            barClose: sig.barClose,
            dueAt: gradeDueAt(sig.barClose, hyp.timeframe),
          });
          break;
        }

        const norm = normalizeFundingSumsResult(fundingRaw);
        fundingSums = norm.sums;

        const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
        let normalCoverageMissing = false;
        for (const sym of normalCoins) {
          if (!norm.coverage[sym]) {
            normalCoverageMissing = true;
            if (now > end + FORTY_EIGHT_HOURS) {
              report.errors.push(
                `Funding coverage gap older than 48 hours for ${sym} at windowEnd ${end} in hypothesis ${hyp.id}`
              );
            }
          }
        }

        if (normalCoverageMissing) {
          report.pending.push({
            hypothesis: hyp.id,
            barClose: sig.barClose,
            dueAt: gradeDueAt(sig.barClose, hyp.timeframe),
          });
          break;
        }

        for (const sym of delistedCoins) {
          if (fundingSums[sym] === undefined) {
            fundingSums[sym] = 0;
          }
        }
      }

      const input: BookGradeInput = {
        hypothesis: hyp,
        barClose: sig.barClose,
        late: sig.late,
        scores: sig.scores,
        prices,
        fundingSums,
        delisted: delistedCoins,
        prev: {
          state: prev.state,
          weights: prev.weights,
        },
        gradedAt: new Date(d.clock()),
      };

      const row = gradeBookBar(input);

      const { inserted } = await insertLabScoreOnce(row);
      if (!inserted) {
        break;
      }

      prev.state = row.state;
      prev.weights = row.weights;

      report.graded.push({
        hypothesis: hyp.id,
        barClose: sig.barClose,
        bet: row.bet,
        x: row.x,
        b: row.b,
        e: eValue(row.state),
      });
    }
  }
}

export async function runLabGrade(
  now: number,
  deps?: LabGradeDeps
): Promise<LabGradeReport> {
  await connectDB();

  const d: LabGradeDeps = {
    fetchPerpKlinesRange: deps?.fetchPerpKlinesRange ?? defaultLabGradeDeps.fetchPerpKlinesRange,
    fundingSumsFor: deps?.fundingSumsFor ?? defaultLabGradeDeps.fundingSumsFor,
    syncFundingSettlements: deps?.syncFundingSettlements ?? defaultLabGradeDeps.syncFundingSettlements,
    fetchPerpExchangeInfo: deps?.fetchPerpExchangeInfo ?? defaultLabGradeDeps.fetchPerpExchangeInfo,
    sleep: deps?.sleep ?? defaultLabGradeDeps.sleep,
    clock: deps?.clock ?? defaultLabGradeDeps.clock,
  };

  const report: LabGradeReport = {
    success: true,
    graded: [],
    pending: [],
    errors: [],
  };

  try {
    await gradeLabV1AndV2(now, d, deps, report);
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
    report.success = false;
  }
  try {
    await gradeLabV3(now, d, deps, report);
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
    report.success = false;
  }
  return report;
}
