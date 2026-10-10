import type { SignalTier } from '@/types/signal';

import type { CallOutcome, MonthMeasures, PointMeasures } from './types';

/**
 * Pure measures for the track record, shared by the loader (re-scored year) and
 * the route (live record) so both halves of the panel are computed one way.
 * The definitions are the live-record study's (scripts/research/live-record-stats.ts):
 * buy tiers are right when the forward return is above zero, sell tiers when it
 * is below, and net = mean(d x return) - cost over every buy and sell row. A
 * parity test pins bh and net to that module's cellMeasures.
 */

export interface MeasuredRow {
  tier: string;
  forwardReturnPercent: number;
}

export function directionOf(tier: string): 1 | -1 | 0 {
  if (tier === 'buy' || tier === 'strong_buy') return 1;
  if (tier === 'sell' || tier === 'strong_sell') return -1;
  return 0;
}

/** Null for a neutral bar (no call) or an outcome not known yet. */
export function outcomeOf(tier: string, fwd: number | null, costPercent: number): CallOutcome | null {
  const d = directionOf(tier);
  if (d === 0 || fwd === null || !Number.isFinite(fwd)) return null;
  const directional = d * fwd;
  if (directional <= 0) return 'wrong';
  return directional > costPercent ? 'won' : 'cost';
}

const share = (count: number, total: number): number | null => (total > 0 ? count / total : null);

export function pointMeasures(rows: readonly MeasuredRow[], costPercent: number): PointMeasures {
  let buyN = 0;
  let sellN = 0;
  let buyRight = 0;
  let sellRight = 0;
  let sum = 0;
  let wonAfterCost = 0;
  let winSum = 0;
  let lossSum = 0;
  for (const row of rows) {
    const d = directionOf(row.tier);
    if (d === 0) continue;
    const directional = d * row.forwardReturnPercent;
    const right = directional > 0;
    if (d === 1) {
      buyN++;
      if (right) buyRight++;
    } else {
      sellN++;
      if (right) sellRight++;
    }
    sum += directional;
    if (directional > costPercent) wonAfterCost++;
    if (right) winSum += directional;
    else lossSum -= directional;
  }
  const calls = buyN + sellN;
  const rightCount = buyRight + sellRight;
  const wrongCount = calls - rightCount;
  const buyHit = share(buyRight, buyN);
  const sellHit = share(sellRight, sellN);
  const meanBefore = calls > 0 ? sum / calls : null;
  const avgWin = rightCount > 0 ? winSum / rightCount : null;
  const avgLoss = wrongCount > 0 ? lossSum / wrongCount : null;
  const breakEven =
    avgWin !== null && avgLoss !== null && avgWin + avgLoss > 0 ? (avgLoss + costPercent) / (avgWin + avgLoss) : null;
  return {
    calls,
    buyN,
    sellN,
    buyHit,
    sellHit,
    bh: buyHit !== null && sellHit !== null ? (buyHit + sellHit) / 2 : null,
    right: share(rightCount, calls),
    meanBefore,
    net: meanBefore === null ? null : meanBefore - costPercent,
    wonAfterCost: share(wonAfterCost, calls),
    avgWin,
    avgLoss,
    breakEven,
  };
}

export function monthOf(t: number): string {
  return new Date(t).toISOString().slice(0, 7);
}

/** Point measures per UTC month of the signal bar, oldest first. Months with no call are kept with calls 0. */
export function monthMeasures(
  rows: ReadonlyArray<MeasuredRow & { candleTimestamp: number }>,
  costPercent: number
): MonthMeasures[] {
  const byMonth = new Map<string, Array<MeasuredRow & { candleTimestamp: number }>>();
  for (const row of rows) {
    const key = monthOf(row.candleTimestamp);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(row);
    else byMonth.set(key, [row]);
  }
  return [...byMonth.keys()].sort().map((month) => {
    const m = pointMeasures(byMonth.get(month) as MeasuredRow[], costPercent);
    return { month, calls: m.calls, right: m.right, bh: m.bh, net: m.net };
  });
}

const TIER_CODES: Record<SignalTier, number> = {
  strong_sell: -2,
  sell: -1,
  neutral: 0,
  buy: 1,
  strong_buy: 2,
};
const TIERS_BY_CODE: Record<number, SignalTier> = {
  [-2]: 'strong_sell',
  [-1]: 'sell',
  0: 'neutral',
  1: 'buy',
  2: 'strong_buy',
};

/** Compact storage code of a tier: -2 strong sell to 2 strong buy. */
export function tierCode(tier: SignalTier): number {
  const code = TIER_CODES[tier];
  if (code === undefined) throw new Error(`Unknown tier: ${tier}`);
  return code;
}

export function tierFromCode(code: number): SignalTier {
  const tier = TIERS_BY_CODE[code];
  if (tier === undefined) throw new Error(`Unknown tier code: ${code}`);
  return tier;
}
