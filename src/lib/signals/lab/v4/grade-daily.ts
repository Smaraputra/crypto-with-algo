import type { LabScoreFields } from '@/lib/models/lab-score';
import {
  LAB_V4_DAILY_SCALE,
  LAB_V4_ROUND_TRIP,
  LAB_V4_THRESHOLD,
  type LabHypothesis,
} from '@/lib/signals/lab/candidates';
import {
  stepEProcess,
  type EProcessState,
} from '@/lib/signals/lab/e-process';

export interface DailyTrade {
  symbol: string;
  side: 1 | -1;
  entryTime: number; // ms UTC, T + 10m
  exitTime: number; // ms UTC, entryTime + 8h
  barClose?: number; // ms UTC, T
}

export interface DailyFundingSettlement {
  symbol: string;
  rate: number;
  fundingTime?: number;
  time?: number;
}

export interface DailyTradeReturnPart {
  symbol: string;
  entryTime: number;
  side: 1 | -1;
  P_start: number;
  P_end: number;
  gross: number;
  cost: number;
  funding: number;
  net: number;
}

export interface DailyBookReturnResult {
  R_d: number;
  net: number;
  gross: number;
  cost: number;
  funding: number;
  parts: DailyTradeReturnPart[];
}

export interface DailyGradeBarInput {
  hypothesis: Pick<LabHypothesis, 'id'> & Partial<LabHypothesis>;
  dayStart: number;
  trades: readonly DailyTrade[];
  prices5m: Record<string, Record<number, number>> | Map<string, Map<number, number>>;
  settlements: readonly DailyFundingSettlement[] | Record<string, readonly DailyFundingSettlement[]>;
  fundingGaps?: string[] | null;
  prev: {
    state: EProcessState;
    weights?: Record<string, number> | null;
  };
  gradedAt: Date;
}

function getPrice(
  prices5m: Record<string, Record<number, number>> | Map<string, Map<number, number>>,
  symbol: string,
  time: number
): number | undefined {
  if (prices5m instanceof Map) {
    return prices5m.get(symbol)?.get(time);
  }
  return prices5m[symbol]?.[time];
}

function getSettlementsForSymbol(
  settlements: readonly DailyFundingSettlement[] | Record<string, readonly DailyFundingSettlement[]>,
  symbol: string
): readonly DailyFundingSettlement[] {
  if (Array.isArray(settlements)) {
    return settlements.filter((s) => s.symbol === symbol);
  }
  const record = settlements as Record<string, readonly DailyFundingSettlement[]>;
  return record[symbol] ?? [];
}

/**
 * Pure: computes R_d and its parts for trades open during day d (dayStart to dayStart + 24h).
 *
 * R_d is the sum over trades open during d of side x ln(P_end / P_start) minus costs and funding:
 * - P_start is entry price if entry falls in d, else open of 5m bar at day's 00:00
 * - P_end is exit price if exit falls in d, else open of 5m bar at next 00:00
 * - 0.0014 subtracted for each trade on its entry day
 * - side x rate subtracted for settlements in (dayStart, dayEnd] and inside trade's (entry, exit] window
 */
export function dailyBookReturn(
  trades: readonly DailyTrade[],
  prices5m: Record<string, Record<number, number>> | Map<string, Map<number, number>>,
  settlements: readonly DailyFundingSettlement[] | Record<string, readonly DailyFundingSettlement[]>,
  dayStart: number
): DailyBookReturnResult {
  const dayEnd = dayStart + 86_400_000;
  let totalGross = 0;
  let totalCost = 0;
  let totalFunding = 0;
  const parts: DailyTradeReturnPart[] = [];

  for (const trade of trades) {
    const isTradeOpenInDay = trade.entryTime < dayEnd && trade.exitTime > dayStart;
    if (!isTradeOpenInDay) {
      continue;
    }

    const isEntryInDay = trade.entryTime >= dayStart && trade.entryTime < dayEnd;
    const startTime = isEntryInDay ? trade.entryTime : dayStart;
    const P_start = getPrice(prices5m, trade.symbol, startTime);

    if (typeof P_start !== 'number' || !Number.isFinite(P_start) || P_start <= 0) {
      throw new Error(`Missing price for ${trade.symbol} at ${startTime}`);
    }

    const isExitInDay = trade.exitTime > dayStart && trade.exitTime <= dayEnd;
    const endTime = isExitInDay ? trade.exitTime : dayEnd;
    const P_end = getPrice(prices5m, trade.symbol, endTime);

    if (typeof P_end !== 'number' || !Number.isFinite(P_end) || P_end <= 0) {
      throw new Error(`Missing price for ${trade.symbol} at ${endTime}`);
    }

    const gross_t = trade.side * Math.log(P_end / P_start);
    const cost_t = isEntryInDay ? LAB_V4_ROUND_TRIP : 0;

    const symSettlements = getSettlementsForSymbol(settlements, trade.symbol);
    let funding_t = 0;
    for (const s of symSettlements) {
      const fTime = s.fundingTime ?? s.time ?? 0;
      if (
        fTime > dayStart &&
        fTime <= dayEnd &&
        fTime > trade.entryTime &&
        fTime <= trade.exitTime
      ) {
        funding_t += trade.side * s.rate;
      }
    }

    const net_t = gross_t - cost_t - funding_t;

    totalGross += gross_t;
    totalCost += cost_t;
    totalFunding += funding_t;

    parts.push({
      symbol: trade.symbol,
      entryTime: trade.entryTime,
      side: trade.side,
      P_start,
      P_end,
      gross: gross_t,
      cost: cost_t,
      funding: funding_t,
      net: net_t,
    });
  }

  const R_d = totalGross - totalCost - totalFunding;

  return {
    R_d,
    net: R_d,
    gross: totalGross,
    cost: totalCost,
    funding: totalFunding,
    parts,
  };
}

/** Pure: grades one lab-v4 daily bar, stepping the e-process. */
export function gradeDailyBar(input: DailyGradeBarInput): LabScoreFields {
  let scale = input.hypothesis.scale;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    if (input.hypothesis.id.startsWith('S1')) {
      scale = LAB_V4_DAILY_SCALE.S1;
    } else if (input.hypothesis.id.startsWith('S2')) {
      scale = LAB_V4_DAILY_SCALE.S2;
    } else {
      throw new Error(`Invalid or missing scale for hypothesis ${input.hypothesis.id}`);
    }
  }

  const dayEnd = input.dayStart + 86_400_000;
  const openTrades = input.trades.filter(
    (t) => t.entryTime < dayEnd && t.exitTime > input.dayStart
  );

  if (openTrades.length === 0) {
    return {
      version: 'lab-v4',
      hypothesis: input.hypothesis.id,
      barClose: input.dayStart,
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
      fundingGaps: input.fundingGaps ?? null,
      state: { ...input.prev.state },
    };
  }

  const ret = dailyBookReturn(
    openTrades,
    input.prices5m,
    input.settlements,
    input.dayStart
  );

  const R_d = ret.R_d;
  const x = Math.min(R_d / scale, 1);

  /**
   * Weights, prices and funding are keyed by `${symbol}@${entryTime}`.
   * This preserves distinct records when a coin has multiple trades in one day.
   */
  const weights: Record<string, number> = {};
  const prices: Record<string, { start: number; end: number }> = {};
  const funding: Record<string, number> = {};

  for (const part of ret.parts) {
    const key = `${part.symbol}@${part.entryTime}`;
    weights[key] = part.side;
    prices[key] = {
      start: part.P_start,
      end: part.P_end,
    };
    funding[key] = (funding[key] ?? 0) + part.funding;
  }

  if (input.prev.state.absorbed) {
    return {
      version: 'lab-v4',
      hypothesis: input.hypothesis.id,
      barClose: input.dayStart,
      gradedAt: input.gradedAt,
      n: ret.parts.length,
      x,
      b: 0,
      turnover: null,
      kN: null,
      s: null,
      sHat: null,
      lambda: 0,
      lambda0: 0,
      bet: false,
      noBetReason: 'absorbed',
      weights,
      netBookReturn: R_d,
      prices,
      funding,
      fundingGaps: input.fundingGaps ?? null,
      state: { ...input.prev.state },
    };
  }

  const step = stepEProcess(
    input.prev.state,
    { barTime: input.dayStart, x, b: 0 },
    { threshold: LAB_V4_THRESHOLD, lossUnbounded: true }
  );

  return {
    version: 'lab-v4',
    hypothesis: input.hypothesis.id,
    barClose: input.dayStart,
    gradedAt: input.gradedAt,
    n: ret.parts.length,
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
      : step.state.absorbed
      ? 'absorbed'
      : 'degenerate',
    weights,
    netBookReturn: R_d,
    prices,
    funding,
    fundingGaps: input.fundingGaps ?? null,
    state: step.state,
  };
}
