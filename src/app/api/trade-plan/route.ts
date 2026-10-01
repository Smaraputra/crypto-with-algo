import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { cachedFetch } from '@/lib/redis';
import { getCandles } from '@/lib/candle-ingestion';
import { GlobalSignal } from '@/lib/models/global-signal';
import { HistoricalSnapshot } from '@/lib/models/historical-snapshot';
import type { TradingStyle } from '@/lib/models/signal-template';
import { STYLE_CONFIGS, TRADING_STYLES } from '@/lib/indicators/style-configs';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { getLiveTierExpectancy } from '@/lib/signals/outcome-analytics';
import { OUTCOME_HORIZON_BARS } from '@/lib/signals/outcome-horizons';
import { mapToSnapshotInterval } from '@/lib/backtest/snapshot-series';
import { defaultCostPercent } from '@/lib/backtest/cost-model';
import { TradePlanError, buildTradePlan } from '@/lib/trade-plan/build';
import { STOP_WINDOW_BARS } from '@/lib/trade-plan/rule';
import type { LiveRecord, TradePlanResponse } from '@/lib/trade-plan/types';

/** The live record changes only as outcomes resolve (every 15 minutes), and its aggregate is the heaviest read here. */
const LIVE_RECORD_CACHE_SECONDS = 600;

function isTradingStyle(value: string): value is TradingStyle {
  return (TRADING_STYLES as readonly string[]).includes(value);
}

async function liveRecordFor(
  tradingStyle: TradingStyle,
  interval: string,
  configVersion: number
): Promise<LiveRecord> {
  const costPercentRoundTrip = defaultCostPercent(interval);
  return cachedFetch(
    `trade-plan:live-record:${tradingStyle}:${interval}:v${configVersion}`,
    async () => {
      const tiers = await getLiveTierExpectancy({
        tradingStyle,
        interval,
        configVersion,
        costPercentRoundTrip,
      });
      return {
        configVersion,
        horizonBars: OUTCOME_HORIZON_BARS[tradingStyle],
        costPercentRoundTrip,
        tiers: tiers.map(({ tier, count, expectancyPercent, winRate }) => ({
          tier,
          count,
          expectancyPercent,
          winRate,
        })),
      };
    },
    LIVE_RECORD_CACHE_SECONDS
  );
}

/**
 * GET /api/trade-plan?symbol=&tradingStyle=&interval=
 *
 * The order ticket the composite's own rule would place on the latest scored
 * bar, with its costs and the recorded evidence for that rule. Read-only: it
 * never scores and never writes a GlobalSignal.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const symbol = params.get('symbol');
  const tradingStyle = params.get('tradingStyle');
  const interval = params.get('interval');

  if (!symbol || !(SIGNAL_SYMBOLS as readonly string[]).includes(symbol)) {
    return NextResponse.json({ error: 'symbol must be one of the signal symbols' }, { status: 400 });
  }
  if (!tradingStyle || !isTradingStyle(tradingStyle)) {
    return NextResponse.json({ error: `Invalid trading style: ${tradingStyle}` }, { status: 400 });
  }
  if (!interval || !STYLE_CONFIGS[tradingStyle].preferredIntervals.includes(interval)) {
    return NextResponse.json(
      { error: `Interval ${interval} is not scored for ${tradingStyle}` },
      { status: 400 }
    );
  }

  await connectDB();

  const signal = await GlobalSignal.findOne({ symbol, tradingStyle, interval })
    .sort({ createdAt: -1 })
    .lean();

  if (!signal) {
    const body: TradePlanResponse = {
      plan: null,
      unavailableReason: `No ${interval} signal has been computed for ${symbol} yet.`,
      liveRecord: null,
    };
    return NextResponse.json(body);
  }

  const [candles, fundingRow, liveRecord] = await Promise.all([
    getCandles(symbol, interval, undefined, signal.candleTimestamp, STOP_WINDOW_BARS + 1),
    HistoricalSnapshot.findOne({
      symbol,
      interval: mapToSnapshotInterval(interval),
      'data.fundingRate.rate': { $exists: true },
    })
      .sort({ timestamp: -1 })
      .lean(),
    liveRecordFor(tradingStyle, interval, signal.configVersion),
  ]);

  const fundingRate = fundingRow?.data?.fundingRate?.rate;

  try {
    const plan = buildTradePlan({
      symbol,
      style: tradingStyle,
      interval,
      signal: {
        score: signal.score,
        tier: signal.tier,
        candleTimestamp: signal.candleTimestamp,
        configVersion: signal.configVersion,
        createdAt: signal.createdAt,
      },
      candles,
      fundingRate: typeof fundingRate === 'number' ? fundingRate : null,
    });
    const body: TradePlanResponse = { plan, unavailableReason: null, liveRecord };
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof TradePlanError) {
      const body: TradePlanResponse = { plan: null, unavailableReason: error.message, liveRecord };
      return NextResponse.json(body);
    }
    throw error;
  }
}
