import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/lib/auth';
import { authenticatedLimiter, rateLimitUser } from '@/lib/rate-limit';
import { fetchKlines } from '@/lib/binance';
import { getCandles, dropOpenBars } from '@/lib/candle-ingestion';
import { fetchFundingRate, fetchLongShortRatio } from '@/lib/binance-futures';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { interpretIndicators } from '@/lib/indicators/interpret';
import { TRADING_STYLES } from '@/lib/indicators/style-configs';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { RECOMMENDED_CANDLES } from '@/lib/indicators/types';
import { VALID_INTERVALS } from '@/lib/models/candle';
import { GlobalSignal } from '@/lib/models/global-signal';
import { Signal } from '@/lib/models/signal';
import type { TradingStyle } from '@/lib/models/signal-template';
import { connectDB } from '@/lib/mongodb';
import { cachedFetch } from '@/lib/redis';
import { computeSignalBatch } from '@/lib/signals/compute-engine';
import { computeSignalScore } from '@/lib/signals/scorer';
import { fetchFearAndGreed } from '@/lib/external/fear-greed';
import type { FuturesData } from '@/types/futures';
import type { SentimentData } from '@/types/signal';

const computeSchema = z.object({
  symbol: z.string().min(1),
  // dropOpenBars throws on an unknown interval; reject it at the boundary
  // instead of leaking an uncaught-error 500.
  interval: z.enum(VALID_INTERVALS).default('1h'),
  tradingStyle: z.enum(TRADING_STYLES as unknown as [string, ...string[]]).optional(),
});

async function fetchFuturesDataSafe(symbol: string): Promise<FuturesData> {
  const result: FuturesData = {
    fundingRate: null,
    openInterest: null,
    longShortRatio: null,
  };

  try {
    const rates = await cachedFetch(
      `futures:funding:${symbol}:1`,
      () => fetchFundingRate(symbol, 1),
      300
    );
    if (rates.length > 0) result.fundingRate = rates[0];
  } catch {
    // Futures data is optional
  }

  try {
    const ratios = await cachedFetch(
      `futures:ls:top:${symbol}:1h:1`,
      () => fetchLongShortRatio(symbol, '1h', 1),
      300
    );
    if (ratios.length > 0) result.longShortRatio = ratios[0];
  } catch {
    // Futures data is optional
  }

  return result;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await rateLimitUser(session.user.id, authenticatedLimiter);
  if (limited) return limited;

  const body = await req.json();
  const parsed = computeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const { symbol, interval, tradingStyle } = parsed.data;

  try {
    // Global signal path: use compute-engine batch infrastructure
    if (tradingStyle) {
      await connectDB();
      await computeSignalBatch([
        { symbol, interval, tradingStyle: tradingStyle as TradingStyle },
      ]);

      const doc = await GlobalSignal.findOne({
        symbol,
        interval,
        tradingStyle,
      })
        .sort({ createdAt: -1 })
        .lean();

      if (!doc) {
        return NextResponse.json(
          { error: 'Signal computation produced no result' },
          { status: 500 }
        );
      }

      return NextResponse.json({ signal: doc });
    }

    // Legacy per-user signal path (no tradingStyle)
    // Single point-in-time reference, used both inside the cachedFetch
    // producer (below) and for the outer safety-net filter, so a bar open
    // when the fetchKlines fallback ran can never be served "closed" later
    // from the 60s cache just because wall-clock time moved on.
    const now = Date.now();

    // Fetch candle data and futures data in parallel
    // Try MongoDB first (faster, avoids Binance rate limits), fall back to direct API
    const [rawCandles, futuresData, sentimentData] = await Promise.all([
      cachedFetch(
        `klines:${symbol}:${interval}:${RECOMMENDED_CANDLES}`,
        async () => {
          const dbCandles = await getCandles(
            symbol,
            interval,
            undefined,
            undefined,
            RECOMMENDED_CANDLES
          );
          if (dbCandles.length >= RECOMMENDED_CANDLES) return dbCandles;
          const apiCandles = await fetchKlines(symbol, interval, RECOMMENDED_CANDLES);
          return dropOpenBars(apiCandles, interval, now);
        },
        60
      ),
      fetchFuturesDataSafe(symbol),
      fetchFearAndGreed().catch((): SentimentData | null => null),
    ]);

    // Score closed bars only: safety net for candles read straight from
    // Mongo (the fetchKlines fallback above already filtered its batch).
    // Same status and error shape as the global-signal branch's "no result"
    // response above: both mean "compute-engine/this route had nothing
    // scoreable for this exact request right now, retry shortly."
    const candles = dropOpenBars(rawCandles, interval, now);
    if (candles.length === 0) {
      console.log(`signals/compute legacy: no closed candle for ${symbol}:${interval}`);
      return NextResponse.json(
        { error: 'No closed candle available' },
        { status: 500 }
      );
    }

    // Compute indicators
    const raw = computeAllIndicators(candles, symbol, interval);
    const indicators = interpretIndicators(raw);
    const superTrend = computeSuperTrend(candles);

    // Compute composite signal
    const signal = computeSignalScore(
      indicators,
      futuresData,
      sentimentData,
      undefined, // Default weights
      superTrend
    );

    // Persist to DB
    await connectDB();
    const saved = await Signal.create({
      userId: session.user.id,
      symbol: signal.symbol,
      interval: signal.interval,
      score: signal.score,
      tier: signal.tier,
      confidence: signal.confidence,
      components: signal.components,
    });

    return NextResponse.json({
      signal: {
        ...signal,
        _id: saved._id,
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to compute signal';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
