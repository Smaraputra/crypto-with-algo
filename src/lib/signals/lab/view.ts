import type { LabCandidateId, LabTimeframeAny } from './candidates';

export type LabStatus = 'not_started' | 'under_test' | 'validated' | 'not_shown';

export interface LabCoinView {
  symbol: string;
  score: number;
  /** 1 = highest score of the bar. Ties share the order of the symbol name. */
  rank: number;
  /** L2 only: the v8 score and rv-v1 rank the combined score was built from. */
  parts?: { v8: number | null; rvRank: number | null };
}

export interface LabHypothesisView {
  id: string;
  candidate: LabCandidateId;
  timeframe: LabTimeframeAny;
  status: LabStatus;
  /** ISO time of the first graded bar, null before one exists. */
  underTestSince: string | null;
  /** underTestSince plus 24 months, null before. */
  testEndsAt: string | null;
  validatedAt: string | null;
  gradedBars: number;
  /** Bars that placed a bet (state.n of the latest graded row). */
  betBars: number;
  e: number;
  /** e at b = 0, shown as context only. */
  e0: number;
  threshold: number;
  /** Mean X over betting bars (sumX / n), null when n is 0. */
  meanX: number | null;
  /** Mean b over betting bars ((sumX - sumD) / n), null when n is 0. */
  meanB: number | null;
  /** b of the latest graded bar. */
  currentB: number | null;
  latestBar: { barClose: string; late: boolean; coins: LabCoinView[]; skipped: { symbol: string; reason: string }[] } | null;
}

export interface LabResponse {
  version: 'lab-v1';
  threshold: number;
  hypotheses: LabHypothesisView[];
}

export interface LabV2HypothesisView {
  id: string;
  candidate: 'N2' | 'N3';
  timeframe: '1w' | '1d';
  status: LabStatus;
  underTestSince: string | null;
  testEndsAt: string | null;
  validatedAt: string | null;
  gradedBars: number;
  betBars: number;
  e: number;
  threshold: number;
  absorbed: boolean;
  meanNetReturn: number | null;
  lastNetReturn: number | null;
  scale: number;
  latestBar: {
    barClose: string;
    late: boolean;
    positions: { symbol: string; weight: number }[];
    cash: boolean;
  } | null;
}

export interface LabV2Response {
  version: 'lab-v2';
  threshold: number;
  hypotheses: LabV2HypothesisView[];
}

export interface LabV3HypothesisView {
  id: string;
  candidate: 'F1';
  timeframe: '1d';
  status: LabStatus;
  underTestSince: string | null;
  testEndsAt: string | null;
  validatedAt: string | null;
  gradedBars: number;
  betBars: number;
  e: number;
  threshold: number;
  absorbed: boolean;
  meanNetReturn: number | null;
  lastNetReturn: number | null;
  scale: number;
  latestBar: {
    barClose: string;
    late: boolean;
    positions: { symbol: string; weight: number }[];
    cash: boolean;
  } | null;
}

export interface LabV3Response {
  version: 'lab-v3';
  threshold: number;
  hypotheses: LabV3HypothesisView[];
}

export interface LabV4DailyView {
  e: number;
  bets: number;
  crossedAt: string | null;
  lastDay: string | null;
  judged: boolean;
  label?: string;
}

export interface LabV4HypothesisView {
  id: string;
  candidate: 'S1' | 'S2';
  timeframe: '1h';
  status: LabStatus;
  underTestSince: string | null;
  testEndsAt: string | null;
  validatedAt: string | null;
  gradedBars: number;
  betBars: number;
  e: number;
  threshold: number;
  absorbed: boolean;
  meanNetReturn: number | null;
  meanNetPerTrade?: number | null;
  lastNetReturn: number | null;
  scale: number;
  openTrades: { symbol: string; side: 1 | -1; enteredAt: string; exitsAt: string }[];
  closedTrades: {
    symbol: string;
    side: 1 | -1;
    enteredAt: string;
    exitedAt: string;
    move: number;
    outcome: 'won' | 'cost' | 'wrong';
  }[];
  latestBar: {
    barClose: string;
    late: boolean;
    entries: { symbol: string; side: 1 | -1 }[];
  } | null;
  daily?: LabV4DailyView | null;
}

export interface LabV4Response {
  version: 'lab-v4';
  threshold: number;
  hypotheses: LabV4HypothesisView[];
  entries?: { hypothesis: string; barClose: string; symbol: string; side: 1 | -1 }[];
}

/** 'validated' when crossedAt is set, 'not_shown' when now is past testEndsAt, 'under_test' with a graded bar, else 'not_started'. */
export function labStatus(input: { firstGradedAt: number | null; crossedAt: number | null; now: number }): LabStatus {
  if (input.crossedAt !== null) {
    return 'validated';
  }
  if (input.firstGradedAt === null) {
    return 'not_started';
  }
  const testEndsAt = addMonthsUtc(input.firstGradedAt, 24);
  if (input.now > testEndsAt) {
    return 'not_shown';
  }
  return 'under_test';
}

/** Adds 24 calendar months in UTC (Date.UTC month arithmetic). */
export function addMonthsUtc(ms: number, months: number): number {
  const d = new Date(ms);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() + months,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds()
  );
}

/** Coins of a stored signal ranked by score, descending, ties by symbol name. */
export function rankCoins(scores: Record<string, number>): { symbol: string; score: number; rank: number }[] {
  const entries = Object.entries(scores).map(([symbol, score]) => ({
    symbol,
    score,
  }));
  entries.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.symbol.localeCompare(b.symbol);
  });
  return entries.map((entry, index) => ({
    symbol: entry.symbol,
    score: entry.score,
    rank: index + 1,
  }));
}
