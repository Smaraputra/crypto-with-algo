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
