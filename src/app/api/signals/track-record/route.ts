import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { createRateLimiter, rateLimitUser } from '@/lib/rate-limit';
import { cachedFetch } from '@/lib/redis';
import { SCORER_CONFIG_VERSION } from '@/lib/signals/config-version';
import { trackQuerySchema } from '@/lib/signals/track-record/schema';
import { boundaryOf, liveTrack, loadTrackRun } from '@/lib/signals/track-record/server';
import { trackRecordCell, type TrackRecordResponse } from '@/lib/signals/track-record/types';

/**
 * GET /api/signals/track-record?symbol=&interval=&style=
 *
 * The track record of one symbol in one scored cell: the pinned historical
 * re-score's pooled verdict and this symbol's year (precomputed by
 * scripts/ops/load-rescore.ts), plus the scheduler's own resolved calls since
 * the live start, read from SignalOutcome.
 *
 * Read only. It writes no collection and no Redis key the scheduler reads
 * (its cache keys start with `track-record:`). The re-scored half is
 * hindsight, labelled as such by the client, and never joins the live record.
 */

const limiter = createRateLimiter(30, 60);
const LIVE_TTL_SECONDS = 120;

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const limited = await rateLimitUser(`track-record:${session.user.id}`, limiter);
  if (limited) return limited;

  const params = req.nextUrl.searchParams;
  const parsed = trackQuerySchema.safeParse({
    symbol: params.get('symbol') ?? undefined,
    style: params.get('style') ?? undefined,
    interval: params.get('interval') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const { symbol, style, interval } = parsed.data;
  const respond = (body: TrackRecordResponse) =>
    NextResponse.json(body, { headers: { 'Cache-Control': 'private, max-age=60' } });

  if (!trackRecordCell(style, interval)) return respond({ available: false, reason: 'not-scored' });

  try {
    await connectDB();
    const run = await loadTrackRun();
    if (!run) return respond({ available: false, reason: 'no-run' });
    const cellTrack = run.cells.find((c) => c.style === style && c.interval === interval);
    if (!cellTrack) return respond({ available: false, reason: 'not-scored' });

    const symbolTrack = cellTrack.symbols.find((s) => s.symbol === symbol) ?? null;
    const boundary = boundaryOf(symbolTrack, interval);
    const live = await cachedFetch(
      `track-record:live:${run.runId}:${symbol}:${interval}:${style}`,
      () =>
        liveTrack({ symbol, interval, style, configVersion: run.configVersion }, boundary, cellTrack.costPercent),
      LIVE_TTL_SECONDS
    );

    const { cells, ...runMeta } = run;
    void cells;
    const { symbols, ...cellMeta } = cellTrack;
    void symbols;
    return respond({
      available: true,
      run: runMeta,
      cell: cellMeta,
      symbol: symbolTrack,
      live,
      boundary,
      liveConfigVersion: SCORER_CONFIG_VERSION,
    });
  } catch (error) {
    console.error('Track record failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Failed to load the track record' }, { status: 500 });
  }
}
