import { bookWeights } from '@/lib/stats/rank-ic';

export interface FundingSettlement {
  t: number;
  rate: number;
}

export const MIN_SETTLEMENTS_7D = 18;
export const MIN_SCORED_COINS = 8;
export const STAGGER_DAYS = 7;
export const DAY_MS = 86_400_000;

/**
 * Trailing 7-day funding rate score: minus sum of funding rates over settlements in (T - 7d, T].
 * Negative sum means low/negative funding receives a positive score (longed),
 * and high funding receives a negative score (shorted).
 * Requires at least 18 settlements in the 7-day window.
 */
export function computeFund7(
  settlements: readonly FundingSettlement[],
  barClose: number
): { fund7: number | null; count: number; sum: number } {
  const start7 = barClose - 7 * DAY_MS;
  let sum = 0;
  let count = 0;

  for (const s of settlements) {
    if (s.t > start7 && s.t <= barClose) {
      sum += s.rate;
      count++;
    }
  }

  if (count < MIN_SETTLEMENTS_7D) {
    return { fund7: null, count, sum };
  }

  return { fund7: -sum, count, sum };
}

/**
 * Forms the dollar-neutral, gross-1 rank-weighted target book at day T across scored coins.
 * Returns an empty map if fewer than MIN_SCORED_COINS (8) are scored.
 */
export function targetBook(
  scores: Array<{ symbol: string; score: number }>
): Map<string, number> {
  const entries = scores.filter((s) => Number.isFinite(s.score));

  if (entries.length < MIN_SCORED_COINS) {
    return new Map<string, number>();
  }

  entries.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const rawScores = entries.map((e) => e.score);
  const weights = bookWeights(rawScores);

  const result = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const w = weights[i];
    if (Math.abs(w) > 1e-15) {
      result.set(entries[i].symbol, w);
    }
  }

  return result;
}

/**
 * 7-day staggered book: equal average of the target books formed at T, T-1d, ..., T-6d.
 * Each day's target has weight 1/7. An empty or missing past target contributes 0 weight.
 */
export function staggeredBook(
  pastTargets: readonly (Map<string, number> | ReadonlyMap<string, number>)[]
): Map<string, number> {
  const sums = new Map<string, number>();
  const count = Math.min(pastTargets.length, STAGGER_DAYS);

  for (let k = 0; k < count; k++) {
    const target = pastTargets[k];
    for (const [symbol, weight] of target.entries()) {
      sums.set(symbol, (sums.get(symbol) ?? 0) + weight);
    }
  }

  const result = new Map<string, number>();
  for (const [symbol, sum] of sums.entries()) {
    const w = sum / STAGGER_DAYS;
    if (Math.abs(w) > 1e-15) {
      result.set(symbol, w);
    }
  }

  return result;
}
