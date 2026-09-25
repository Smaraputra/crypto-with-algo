import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/lib/auth';
import { fetchKlines } from '@/lib/binance';
import { getCandles, dropOpenBars } from '@/lib/candle-ingestion';
import { fetchFearAndGreed } from '@/lib/external/fear-greed';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { buildIndicatorSnapshot } from '@/lib/indicators/snapshot';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { RECOMMENDED_CANDLES } from '@/lib/indicators/types';
import { VALID_INTERVALS } from '@/lib/models/candle';
import { cachedFetch } from '@/lib/redis';
import type { SentimentData } from '@/types/signal';

const CANDLE_CACHE_TTL_SECONDS = 60;

const querySchema = z.object({
  symbol: z.string().min(1),
  interval: z.enum(VALID_INTERVALS),
});

/**
 * The numeric indicator reading for one symbol and interval, as of the last
 * CLOSED bar.
 *
 * The journal captures this when an entry is created. It used to reconstruct
 * it in the browser from the prose descriptions on whatever `Signal` document
 * the legacy per-user cron had last written -- see `buildIndicatorSnapshot`
 * for what that lost. Computing it here means the reading is the interval that
 * was asked for, carries every field, and is stamped with the bar it came from
 * so a snapshot can be checked against the chart later.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { symbol, interval } = parsed.data;

  try {
    // One point-in-time reference for the whole request, so a bar that was
    // open when the fallback ran cannot be served as closed later out of the
    // 60s cache just because wall-clock time moved on. Same reasoning, and the
    // same cache key, as the compute-signals cron.
    const now = Date.now();

    const rawCandles = await cachedFetch(
      `klines:${symbol}:${interval}:${RECOMMENDED_CANDLES}`,
      async () => {
        const dbCandles = await getCandles(symbol, interval, undefined, undefined, RECOMMENDED_CANDLES);
        if (dbCandles.length >= RECOMMENDED_CANDLES) return dbCandles;
        const apiCandles = await fetchKlines(symbol, interval, RECOMMENDED_CANDLES);
        return dropOpenBars(apiCandles, interval, now);
      },
      CANDLE_CACHE_TTL_SECONDS
    );

    const candles = dropOpenBars(rawCandles, interval, now);
    if (candles.length === 0) {
      return NextResponse.json({ error: 'No closed candle available' }, { status: 503 });
    }

    const raw = computeAllIndicators(candles, symbol, interval);
    const superTrend = computeSuperTrend(candles);
    // Sentiment is decoration on a price reading, so its absence must not cost
    // the caller the rest of the snapshot.
    const sentiment: SentimentData | null = await fetchFearAndGreed().catch(() => null);

    return NextResponse.json({
      snapshot: buildIndicatorSnapshot(raw, superTrend.current.direction, sentiment),
      symbol,
      interval,
      candleTimestamp: raw.lastCandleTime,
    });
  } catch (err) {
    // Too short a history throws out of computeAllIndicators, which is a
    // property of the request, not a server fault.
    const message = err instanceof Error ? err.message : 'Failed to compute snapshot';
    const insufficient = message.startsWith('Insufficient candle data') || message.includes('needs at least');
    return NextResponse.json({ error: message }, { status: insufficient ? 422 : 500 });
  }
}
