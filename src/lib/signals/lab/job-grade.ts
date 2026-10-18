/**
 * Forward signal lab grading jobs (lab-v1).
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

import { fetchPerpKlinesRange } from '@/lib/binance-futures';
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
  LAB_MIN_CROSS_SECTION,
  LAB_TIMEFRAME_MS,
  LAB_V2_THRESHOLD,
  LAB_VERSION,
  LAB_VERSION_V2,
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
  prev: {
    state: EProcessState;
    weights: Record<string, number> | null;
  };
  gradedAt: Date;
}

/** Pure: grades one lab-v2 book metric bar. Never reads anything but its input. */
export function gradeBookBar(input: BookGradeInput): LabScoreFields {
  const candidate =
    input.hypothesis.candidate ??
    (input.hypothesis.id.startsWith('N2') ? 'N2' : 'N3');
  const scale = input.hypothesis.scale ?? (candidate === 'N2' ? 0.13 : 0.8);
  const fundingSums = input.fundingSums ?? input.funding ?? {};
  const version = input.hypothesis.version ?? LAB_VERSION_V2;

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
      funding[sym] = fundingSums[sym] ?? 0;
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
        noBetReason: 'cross_section',
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
      const f_i = -(fundingSums[sym] ?? 0);
      sumReturnFunding += weights[sym] * (r_i + f_i);
    }

    const R = sumReturnFunding - 0.0007 * turnover;
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
        noBetReason: 'late',
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
      noBetReason: step.bet ? null : 'degenerate',
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
      noBetReason: 'no_position',
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
    funding[sym] = fundingSums[sym] ?? 0;
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
      noBetReason: 'no_position',
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
    const f_i = -(fundingSums[sym] ?? 0);
    R += side_i * (r_i + f_i) - 0.0014;
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
      noBetReason: 'late',
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
    noBetReason: step.bet ? null : 'degenerate',
    weights,
    netBookReturn: R,
    prices,
    funding,
    state: step.state,
  };
}

export async function defaultFundingSumsFor(
  symbols: string[],
  fromExclusive: number,
  toInclusive: number
): Promise<Record<string, number>> {
  const settlements = (await FundingSettlement.find(
    {
      symbol: { $in: symbols },
      fundingTime: { $gt: fromExclusive, $lte: toInclusive },
    },
    { symbol: 1, rate: 1 }
  ).lean()) as Array<{ symbol: string; rate: number }>;

  const sums: Record<string, number> = {};
  for (const sym of symbols) {
    sums[sym] = 0;
  }
  for (const s of settlements) {
    if (Number.isFinite(s.rate)) {
      sums[s.symbol] = (sums[s.symbol] ?? 0) + s.rate;
    }
  }
  return sums;
}

export interface LabGradeDeps {
  fetchPerpKlinesRange: typeof fetchPerpKlinesRange;
  fundingSumsFor?: (
    symbols: string[],
    fromExclusive: number,
    toInclusive: number
  ) => Promise<Record<string, number>>;
  syncFundingSettlements?: (symbols: string[], now: number) => Promise<unknown>;
  clock: () => number;
}

export const defaultLabGradeDeps: LabGradeDeps = {
  fetchPerpKlinesRange,
  fundingSumsFor: defaultFundingSumsFor,
  syncFundingSettlements,
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
  pending: { hypothesis: string; barClose: number; dueAt: number }[];
  errors: string[];
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
    clock: deps?.clock ?? defaultLabGradeDeps.clock,
  };

  const report: LabGradeReport = {
    success: true,
    graded: [],
    pending: [],
    errors: [],
  };

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

    if (symbols.length > 0) {
      const fetchResults = await Promise.allSettled(
        symbols.map(async (sym) => {
          const times = Array.from(neededTimesBySymbol.get(sym)!);
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
          priceMapBySymbol.set(sym, klineMap);
        }
      }

      if (anyFailed) {
        report.success = false;
        return report;
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

      for (const sig of dueSignals) {
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
    return report;
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
      return report;
    }
  }

  if (symbolsV2.length > 0 && !deps?.fundingSumsFor && d.syncFundingSettlements) {
    try {
      await d.syncFundingSettlements(symbolsV2, now);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(msg);
      report.success = false;
      return report;
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

      let fundingSums: Record<string, number> = {};
      if (symbolsInScores.length > 0) {
        try {
          fundingSums = await fundingSumsFor(symbolsInScores, start, end);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          report.errors.push(msg);
          report.success = false;
          return report;
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

  return report;
}
