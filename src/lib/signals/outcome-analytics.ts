import type { TradingStyle } from '@/lib/models/signal-template';
import { SIGNAL_TIERS, type SignalTier } from '@/types/signal';
import { SignalOutcome } from '@/lib/models/signal-outcome';

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
  symbol?: string;
  since?: Date;
  costPercentRoundTrip?: number;
}

/** Tiers whose prediction wins when price falls, so the raw long-perspective return is inverted. */
const SELL_TIER_VALUES: SignalTier[] = ['sell', 'strong_sell'];

interface TierExpectancyRow {
  _id: SignalTier;
  count: number;
  meanDirectionalReturn: number;
  winRate: number;
  avgMfePercent: number;
  avgMaePercent: number;
}

/**
 * Live per-tier expectancy from resolved SignalOutcome documents, using the
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
  const { tradingStyle, symbol, since, costPercentRoundTrip = 0 } = opts;

  const match: Record<string, unknown> = {
    tradingStyle,
    status: 'resolved',
    // Resolved outcomes always carry a forward return; excluding a null one
    // outright (rather than coercing it to 0) keeps a data problem from
    // silently diluting the average.
    forwardReturnPercent: { $ne: null },
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
