import type { TradingStyle } from '@/lib/models/signal-template';
import type { SignalTier } from '@/types/signal';
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
const SELL_TIERS: ReadonlySet<SignalTier> = new Set(['sell', 'strong_sell']);

/**
 * Live per-tier expectancy from resolved SignalOutcome documents, using the
 * same directional-return definition the backtest engine uses: buy/strong_buy
 * and neutral (informational) read the forward return as-is, sell/strong_sell
 * flip it since their prediction is that price falls. MFE/MAE are reported
 * as stored, from the long perspective, regardless of tier.
 */
export async function getLiveTierExpectancy(
  opts: GetLiveTierExpectancyOptions
): Promise<TierExpectancy[]> {
  const { tradingStyle, symbol, since, costPercentRoundTrip = 0 } = opts;

  const filter: Record<string, unknown> = { tradingStyle, status: 'resolved' };
  if (symbol) filter.symbol = symbol;
  if (since) filter.resolvedAt = { $gte: since };

  const outcomes = await SignalOutcome.find(filter)
    .select('tier forwardReturnPercent mfePercent maePercent')
    .lean();

  const byTier = new Map<
    SignalTier,
    Array<{ forwardReturnPercent: number; mfePercent: number; maePercent: number }>
  >();

  for (const outcome of outcomes) {
    const tier = outcome.tier;
    const entry = {
      forwardReturnPercent: outcome.forwardReturnPercent ?? 0,
      mfePercent: outcome.mfePercent ?? 0,
      maePercent: outcome.maePercent ?? 0,
    };
    const bucket = byTier.get(tier);
    if (bucket) {
      bucket.push(entry);
    } else {
      byTier.set(tier, [entry]);
    }
  }

  const results: TierExpectancy[] = [];

  for (const [tier, tierOutcomes] of byTier) {
    const directional = SELL_TIERS.has(tier)
      ? tierOutcomes.map((o) => -o.forwardReturnPercent)
      : tierOutcomes.map((o) => o.forwardReturnPercent);

    const count = directional.length;
    const meanReturn = directional.reduce((sum, r) => sum + r, 0) / count;
    const winCount = directional.filter((r) => r > 0).length;
    const avgMfePercent =
      tierOutcomes.reduce((sum, o) => sum + o.mfePercent, 0) / count;
    const avgMaePercent =
      tierOutcomes.reduce((sum, o) => sum + o.maePercent, 0) / count;

    results.push({
      tier,
      count,
      expectancyPercent: meanReturn - costPercentRoundTrip,
      winRate: winCount / count,
      avgMfePercent,
      avgMaePercent,
    });
  }

  return results;
}
