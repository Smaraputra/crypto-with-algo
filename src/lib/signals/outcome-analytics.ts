import type { TradingStyle } from '@/lib/models/signal-template';
import { SIGNAL_TIERS, type SignalTier } from '@/types/signal';
import { SignalOutcome, sourceMatch, type SignalOutcomeSource } from '@/lib/models/signal-outcome';

export interface TierExpectancy {
  tier: SignalTier;
  count: number;
  expectancyPercent: number;
  winRate: number;
  avgMfePercent: number;
  avgMaePercent: number;
}

export interface GetLiveTierExpectancyOptions {
  tradingStyle: TradingStyle;
  /**
   * Required, never pooled: a style scores more than one interval (scalping
   * 1m and 5m, day trading 15m and 1h, swing 4h and 1d), each writing its own
   * outcomes with the style's horizonBars, so a 1m row is a 12-minute forward
   * return and a 5m row a 60-minute one. Averaging them under one cost
   * estimate is a category error, and in production the 1m rows outnumber
   * the 5m rows five to one.
   */
  interval: string;
  symbol?: string;
  since?: Date;
  costPercentRoundTrip?: number;
  source?: SignalOutcomeSource;
}

/** Tiers whose prediction wins when price falls, so the raw long-perspective return is inverted. */
export const SELL_TIER_VALUES: SignalTier[] = ['sell', 'strong_sell'];

/**
 * The directional return of one outcome: the forward return read from the
 * perspective of what the tier predicted. buy/strong_buy and neutral read it
 * as-is; sell/strong_sell win when price falls, so theirs is negated.
 *
 * Exported because the Mongo `$group` pipeline below and the row-level
 * calibration analytics (src/lib/signals/calibration-analytics.ts) must agree
 * on this definition exactly -- the two are compared against each other, and a
 * sign convention that drifts between them would show up as a scorer finding
 * rather than as the bug it would be. The backtest engine uses the same rule.
 */
export function directionalReturn(tier: SignalTier, forwardReturnPercent: number): number {
  return SELL_TIER_VALUES.includes(tier) ? -forwardReturnPercent : forwardReturnPercent;
}

interface TierExpectancyRow {
  _id: SignalTier;
  count: number;
  meanDirectionalReturn: number;
  winRate: number;
  avgMfePercent: number;
  avgMaePercent: number;
}

/**
 * Live per-tier expectancy from resolved SignalOutcome documents of one
 * trading style at one interval, using the
 * same directional-return definition the backtest engine uses: buy/strong_buy
 * and neutral (informational) read the forward return as-is, sell/strong_sell
 * flip it since their prediction is that price falls. MFE/MAE are reported
 * as stored, from the long perspective, regardless of tier.
 *
 * Aggregated in the database rather than loaded into memory, since a
 * symbol-less query can span every resolved outcome for a trading style.
 */
export async function getLiveTierExpectancy(
  opts: GetLiveTierExpectancyOptions
): Promise<TierExpectancy[]> {
  const {
    tradingStyle,
    interval,
    symbol,
    since,
    costPercentRoundTrip = 0,
    source = 'composite',
  } = opts;

  const match: Record<string, unknown> = {
    tradingStyle,
    interval,
    status: 'resolved',
    // Resolved outcomes always carry a forward return; excluding a null one
    // outright (rather than coercing it to 0) keeps a data problem from
    // silently diluting the average.
    forwardReturnPercent: { $ne: null },
    ...sourceMatch(source),
  };
  if (symbol) match.symbol = symbol;
  if (since) match.resolvedAt = { $gte: since };

  const rows: TierExpectancyRow[] = await SignalOutcome.aggregate([
    { $match: match },
    {
      $addFields: {
        directionalReturn: {
          $cond: [
            { $in: ['$tier', SELL_TIER_VALUES] },
            { $multiply: ['$forwardReturnPercent', -1] },
            '$forwardReturnPercent',
          ],
        },
      },
    },
    {
      $group: {
        _id: '$tier',
        count: { $sum: 1 },
        meanDirectionalReturn: { $avg: '$directionalReturn' },
        winRate: { $avg: { $cond: [{ $gt: ['$directionalReturn', 0] }, 1, 0] } },
        avgMfePercent: { $avg: '$mfePercent' },
        avgMaePercent: { $avg: '$maePercent' },
      },
    },
  ]);

  const byTier = new Map(rows.map((row) => [row._id, row]));

  const results: TierExpectancy[] = [];
  for (const tier of SIGNAL_TIERS) {
    const row = byTier.get(tier);
    if (!row) continue;

    results.push({
      tier,
      count: row.count,
      expectancyPercent: row.meanDirectionalReturn - costPercentRoundTrip,
      winRate: row.winRate,
      avgMfePercent: row.avgMfePercent,
      avgMaePercent: row.avgMaePercent,
    });
  }

  return results;
}
