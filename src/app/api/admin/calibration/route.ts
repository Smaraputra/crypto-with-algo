/**
 * GET /api/admin/calibration -- the live signal's calibration record.
 *
 * Read-only by construction. The outcome resolver is the only writer of
 * SignalOutcome and nothing on this path writes anything, which matters
 * because the same collection is the evidence base the configVersion record is
 * read from: a route that could insert into it would contaminate the thing it
 * exists to measure.
 *
 * Admin-gated rather than per-user because the record is global -- these are
 * the scheduler's signals, not a user's trades.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAdmin, adminAuthError, adminAuthStatus } from '@/lib/admin-auth';
import { connectDB } from '@/lib/mongodb';
import { cachedFetch } from '@/lib/redis';
import { defaultCostPercent } from '@/lib/backtest/cost-model';
import { OUTCOME_HORIZON_BARS } from '@/lib/signals/outcome-horizons';
import { STYLE_CONFIGS } from '@/lib/indicators/style-configs';
import {
  bootstrapIterationsFor,
  cumulativeReturn,
  loadCalibrationCoverage,
  loadCalibrationRows,
  reliabilityCurve,
  returnDistribution,
  tierCalibration,
  MIN_BLOCKS_FOR_CI,
  MIN_SAMPLES_FOR_ESTIMATE,
} from '@/lib/signals/calibration-analytics';
import type { TradingStyle } from '@/lib/models/signal-template';

const TRADING_STYLES = ['scalping', 'day_trading', 'swing_trading', 'position_trading'] as const;

/**
 * A fixed seed, not a per-request one. The bootstrap is a measurement, and a
 * confidence interval that moved every time the page was refreshed would read
 * as instability in the signal rather than as the resampling noise it is.
 */
const BOOTSTRAP_SEED = 20260925;

const CACHE_TTL_SECONDS = 300;

const querySchema = z.object({
  style: z.enum(TRADING_STYLES),
  // Required, and validated against the style's own preferredIntervals below:
  // pooling intervals is the defect this route must not be able to reproduce.
  interval: z.string().min(1),
  source: z.enum(['composite', 'llm']).default('composite'),
  symbol: z.string().min(1).optional(),
  configVersion: z.coerce.number().int().nonnegative().optional(),
  since: z.iso.datetime().optional(),
  cost: z.coerce.number().min(0).optional(),
  overlapping: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export async function GET(request: Request) {
  try {
    const admin = await requireAdmin();
    if (!admin.ok) {
      return NextResponse.json(adminAuthError(admin), { status: adminAuthStatus(admin) });
    }

    const params = Object.fromEntries(new URL(request.url).searchParams);
    const parsed = querySchema.safeParse(params);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid query', issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const query = parsed.data;
    const style = query.style as TradingStyle;

    const allowedIntervals = STYLE_CONFIGS[style].preferredIntervals;
    if (!allowedIntervals.includes(query.interval)) {
      return NextResponse.json(
        {
          error: `${style} does not score ${query.interval}`,
          allowedIntervals,
        },
        { status: 400 }
      );
    }

    const horizonBars = OUTCOME_HORIZON_BARS[style];
    const costPercent = query.cost ?? defaultCostPercent(query.interval);

    const cacheKey = [
      'calibration',
      style,
      query.interval,
      query.source,
      query.symbol ?? 'all',
      query.configVersion ?? 'all',
      query.since ?? 'all',
      costPercent.toFixed(4),
      query.overlapping ? 'overlapping' : 'sampled',
    ].join(':');

    const payload = await cachedFetch(
      cacheKey,
      async () => {
        await connectDB();

        const [rows, coverage] = await Promise.all([
          loadCalibrationRows({
            tradingStyle: style,
            interval: query.interval,
            source: query.source,
            configVersion: query.configVersion,
            symbol: query.symbol,
            since: query.since ? new Date(query.since) : undefined,
          }),
          loadCalibrationCoverage({
            tradingStyle: style,
            interval: query.interval,
            source: query.source,
            symbol: query.symbol,
          }),
        ]);

        const iterations = bootstrapIterationsFor(rows.length);
        const estimateOptions = {
          // Block length in timestamp buckets comes from the horizon: rows this
          // many bars apart are the first that share no price history.
          meanBlockLen: Math.max(2, horizonBars),
          iterations,
          seed: BOOTSTRAP_SEED,
        };

        return {
          meta: {
            style,
            interval: query.interval,
            source: query.source,
            symbol: query.symbol ?? null,
            configVersion: query.configVersion ?? null,
            horizonBars,
            costPercentRoundTrip: costPercent,
            costIsDefault: query.cost === undefined,
            rowCount: rows.length,
            bootstrapIterations: iterations,
            meanBlockLenBars: estimateOptions.meanBlockLen,
            minSamplesForEstimate: MIN_SAMPLES_FOR_ESTIMATE,
            minBlocksForCi: MIN_BLOCKS_FOR_CI,
            overlapping: query.overlapping,
            ...coverage,
          },
          tiers: tierCalibration(rows, { ...estimateOptions, costPercentRoundTrip: costPercent }),
          reliability: reliabilityCurve(rows, estimateOptions),
          distribution: returnDistribution(rows),
          cumulative: cumulativeReturn(rows, {
            horizonBars,
            costPercentRoundTrip: costPercent,
            overlapping: query.overlapping,
          }),
        };
      },
      CACHE_TTL_SECONDS
    );

    return NextResponse.json(payload);
  } catch (error) {
    console.error(
      'Error computing signal calibration:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
