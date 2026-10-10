import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/lib/auth';
import { dropOpenBars, getCandles } from '@/lib/candle-ingestion';
import { fetchFearAndGreedUncached } from '@/lib/external/fear-greed';
import { getStyleConfig, TRADING_STYLES } from '@/lib/indicators/style-configs';
import { intervalToMs } from '@/lib/intervals';
import { connectDB } from '@/lib/mongodb';
import type { TradingStyle } from '@/lib/models/signal-template';
import { createRateLimiter, rateLimitUser } from '@/lib/rate-limit';
import { cachedFetch } from '@/lib/redis';
import { SCORER_CONFIG_VERSION } from '@/lib/signals/config-version';
import { getConfirmationInterval } from '@/lib/signals/htf';
import type { ProvisionalContext } from '@/lib/signals/provisional/types';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import {
  fetchNewsSentimentMap,
  getWeightsForStyle,
  htfContextFromClosed,
  storedFuturesForCandle,
} from '@/lib/signals/scoring-inputs';
import type { FuturesData } from '@/types/futures';
import type { HtfContext, SentimentData } from '@/types/signal';

/**
 * GET /api/signals/provisional-context?symbol=&interval=&style=
 *
 * Serves the scorer's INPUTS for the bar forming right now, so the browser can
 * compute a display-only provisional score with the scheduler's own scoring
 * step. It never receives a score, never returns one, and never persists
 * anything.
 *
 * Read-only and no shared cache, by design:
 * - No Mongo writes. GlobalSignal, SignalOutcome, the calibration dashboard,
 *   the live record and the paper desk must only ever see closed-bar scores
 *   written by the scheduler.
 * - No Redis key the scheduler reads. The route must NOT call
 *   `fetchCandlesForTask` or `fetchFearAndGreed`: they write `klines:*` and
 *   `sentiment:fear-greed`, which the scheduler reads, and a stale entry
 *   written just after a bar close could make the scheduler skip or misscore
 *   that bar. Any caching here uses keys starting with `provisional:` only.
 * - No Binance REST call. Closed bars come from Mongo; if the newest one has
 *   not synced yet the response says so instead of fetching it.
 */

const limiter = createRateLimiter(30, 60);

const FEAR_GREED_CACHE_KEY = 'provisional:fear-greed';
const FEAR_GREED_TTL_SECONDS = 300;

const querySchema = z
  .object({
    symbol: z.enum(SIGNAL_SYMBOLS, { error: 'symbol must be a signal symbol.' }),
    style: z.enum(TRADING_STYLES as [TradingStyle, ...TradingStyle[]], {
      error: 'style must be one of the four trading styles.',
    }),
    interval: z.string({ error: 'interval is required.' }),
  })
  .superRefine((value, ctx) => {
    if (!getStyleConfig(value.style).preferredIntervals.includes(value.interval)) {
      ctx.addIssue({
        code: 'custom',
        path: ['interval'],
        message: `interval ${value.interval} is not scored for ${value.style}.`,
      });
    }
  });

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const limited = await rateLimitUser(`provisional-context:${session.user.id}`, limiter);
  if (limited) return limited;

  const params = req.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    symbol: params.get('symbol') ?? undefined,
    style: params.get('style') ?? undefined,
    interval: params.get('interval') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const { symbol, style, interval } = parsed.data;
  const profile = getStyleConfig(style);

  await connectDB();

  const now = Date.now();
  const intervalMs = intervalToMs(interval);
  const formingOpenTime = Math.floor(now / intervalMs) * intervalMs;
  const base = {
    configVersion: SCORER_CONFIG_VERSION,
    symbol,
    interval,
    style,
    formingOpenTime,
    generatedAt: now,
  };
  const respond = (ctx: ProvisionalContext) =>
    NextResponse.json(ctx, { headers: { 'Cache-Control': 'private, no-store' } });

  // The scheduler's own Mongo read and closed-bar filter.
  const closed = dropOpenBars(
    await getCandles(symbol, interval, undefined, undefined, profile.recommendedCandles),
    interval,
    now
  );
  if (closed.length === 0 || closed[closed.length - 1].timestamp !== formingOpenTime - intervalMs) {
    return respond({ ready: false, reason: 'awaiting-candle-sync', ...base });
  }
  // The forming bar completes the window, so keep one fewer than the scheduler scores.
  const closedCandles = closed.slice(-(profile.recommendedCandles - 1));
  if (closedCandles.length + 1 < profile.minCandles) {
    return respond({ ready: false, reason: 'insufficient-history', ...base });
  }

  // Only `timestamp` is read by buildSnapshotSeries, so a stub candle at the
  // forming bar's open time yields exactly the futures input the scheduler
  // will use for that bar once it closes.
  let futures: FuturesData | null = null;
  try {
    futures = await storedFuturesForCandle(
      symbol,
      interval,
      { timestamp: formingOpenTime, open: 0, high: 0, low: 0, close: 0, volume: 0 },
      now,
      new Map()
    );
  } catch {
    // Optional: the category redistributes its weight
  }

  let htfContext: HtfContext | null = null;
  const htfInterval = getConfirmationInterval(interval, style);
  if (htfInterval) {
    try {
      const htfClosed = dropOpenBars(
        await getCandles(symbol, htfInterval, undefined, undefined, profile.recommendedCandles),
        htfInterval,
        now
      );
      htfContext = htfContextFromClosed(htfClosed, htfInterval, profile.config);
    } catch {
      // Optional
    }
  }

  // Mirrors the engine: shared Fear and Greed read plus per-symbol news.
  const fearGreed: SentimentData | null = await cachedFetch(
    FEAR_GREED_CACHE_KEY,
    fetchFearAndGreedUncached,
    FEAR_GREED_TTL_SECONDS
  ).catch(() => null);
  const newsMap = await fetchNewsSentimentMap([symbol]);
  const sentiment: SentimentData | null = fearGreed
    ? { ...fearGreed, news: newsMap.get(symbol) ?? null }
    : null;

  const weights = await getWeightsForStyle(style);

  return respond({
    ready: true,
    ...base,
    closedCandles,
    futures,
    sentiment,
    weights,
    htfContext,
  });
}
