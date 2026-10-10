import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/lib/auth';
import { intervalToMs } from '@/lib/intervals';
import { connectDB } from '@/lib/mongodb';
import { createRateLimiter, rateLimitUser } from '@/lib/rate-limit';
import { cachedFetch } from '@/lib/redis';
import { trackQuerySchema } from '@/lib/signals/track-record/schema';
import { barsInRange, boundaryOf, loadTrackRun } from '@/lib/signals/track-record/server';
import { TRACK_BARS_MAX_SPAN, trackRecordCell, type TrackBarsResponse } from '@/lib/signals/track-record/types';

/**
 * GET /api/signals/track-record/bars?symbol=&interval=&style=&from=&to=
 *
 * The scored bars the chart draws for [from, to] (epoch ms, inclusive): the
 * pinned re-score's bars before the hand-over boundary and the scheduler's
 * live bars (any status, read from SignalOutcome) from it on. At most
 * TRACK_BARS_MAX_SPAN bars of range per request; the client asks in aligned chunks.
 *
 * Read only, like the summary route: no writes, cache keys under `track-record:`.
 */

const limiter = createRateLimiter(120, 60);
const BARS_TTL_SECONDS = 60;

const rangeSchema = z
  .object({
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().nonnegative(),
  })
  .refine((r) => r.to >= r.from, { message: 'to must not be before from.' });

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const limited = await rateLimitUser(`track-record-bars:${session.user.id}`, limiter);
  if (limited) return limited;

  const params = req.nextUrl.searchParams;
  const query = trackQuerySchema.safeParse({
    symbol: params.get('symbol') ?? undefined,
    style: params.get('style') ?? undefined,
    interval: params.get('interval') ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json({ error: query.error.issues[0].message }, { status: 400 });
  }
  const range = rangeSchema.safeParse({ from: params.get('from') ?? undefined, to: params.get('to') ?? undefined });
  if (!range.success) {
    return NextResponse.json({ error: range.error.issues[0].message }, { status: 400 });
  }
  const { symbol, style, interval } = query.data;
  const { from, to } = range.data;

  const cell = trackRecordCell(style, interval);
  const respond = (body: TrackBarsResponse) =>
    NextResponse.json(body, { headers: { 'Cache-Control': 'private, max-age=60' } });
  if (!cell) {
    return respond({ available: false, configVersion: null, boundary: null, horizonBars: 0, costPercent: 0, bars: [] });
  }
  if ((to - from) / intervalToMs(interval) > TRACK_BARS_MAX_SPAN) {
    return NextResponse.json({ error: `The range may span at most ${TRACK_BARS_MAX_SPAN} bars.` }, { status: 400 });
  }

  try {
    await connectDB();
    const run = await loadTrackRun();
    const cellTrack = run?.cells.find((c) => c.style === style && c.interval === interval) ?? null;
    if (!run || !cellTrack) {
      return respond({
        available: false,
        configVersion: null,
        boundary: null,
        horizonBars: cell.horizonBars,
        costPercent: 0,
        bars: [],
      });
    }
    const symbolTrack = cellTrack.symbols.find((s) => s.symbol === symbol) ?? null;
    const boundary = boundaryOf(symbolTrack, interval);
    const bars = await cachedFetch(
      `track-record:bars:${run.runId}:${symbol}:${interval}:${style}:${from}:${to}`,
      () =>
        barsInRange({ runId: run.runId, symbol, interval, style, configVersion: run.configVersion, from, to, boundary }),
      BARS_TTL_SECONDS
    );
    return respond({
      available: true,
      configVersion: run.configVersion,
      boundary,
      horizonBars: cellTrack.horizonBars,
      costPercent: cellTrack.costPercent,
      bars,
    });
  } catch (error) {
    console.error('Track record bars failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Failed to load the track record bars' }, { status: 500 });
  }
}
