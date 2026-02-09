import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/lib/auth';
import { fetchKlines } from '@/lib/binance';
import { fetchFundingRate, fetchLongShortRatio } from '@/lib/binance-futures';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { interpretIndicators } from '@/lib/indicators/interpret';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { RECOMMENDED_CANDLES } from '@/lib/indicators/types';
import { Signal } from '@/lib/models/signal';
import { connectDB } from '@/lib/mongodb';
import { cachedFetch } from '@/lib/redis';
import { computeSignalScore } from '@/lib/signals/scorer';
import type { FuturesData } from '@/types/futures';

const computeSchema = z.object({
  symbol: z.string().min(1),
  interval: z.string().default('1h'),
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

  const body = await req.json();
  const parsed = computeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const { symbol, interval } = parsed.data;

  try {
    // Fetch candle data and futures data in parallel
    const [candles, futuresData] = await Promise.all([
      cachedFetch(
        `klines:${symbol}:${interval}:${RECOMMENDED_CANDLES}`,
        () => fetchKlines(symbol, interval, RECOMMENDED_CANDLES),
        60
      ),
      fetchFuturesDataSafe(symbol),
    ]);

    // Compute indicators
    const raw = computeAllIndicators(candles, symbol, interval);
    const indicators = interpretIndicators(raw);
    const superTrend = computeSuperTrend(candles);

    // Compute composite signal
    const signal = computeSignalScore(
      indicators,
      futuresData,
      null, // Sentiment not yet implemented
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
