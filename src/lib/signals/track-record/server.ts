import { intervalToMs } from '@/lib/intervals';
import { SIGNAL_OUTCOME_STATUSES, SignalOutcome, sourceMatch } from '@/lib/models/signal-outcome';
import { SignalRescoreBar } from '@/lib/models/signal-rescore-bar';
import { SignalRescoreRun } from '@/lib/models/signal-rescore-run';
import type { TradingStyle } from '@/lib/models/signal-template';
import { cachedFetch } from '@/lib/redis';
import type { SignalTier } from '@/types/signal';

import { pointMeasures, tierFromCode } from './measures';
import { trackRunSchema } from './schema';
import { TRACK_RECORD_RUN_ID, type LiveTrack, type SymbolTrack, type TrackBar, type TrackRun } from './types';

/**
 * Server reads behind the track-record routes. READ ONLY: the re-score
 * collections and SignalOutcome are only ever queried here, never written,
 * and every Redis key starts with `track-record:`, which nothing in the
 * scheduler reads.
 */

const RUN_TTL_SECONDS = 300;

/** The pinned run, schema-checked; null until the loader has written it. */
export async function loadTrackRun(): Promise<TrackRun | null> {
  return cachedFetch(
    `track-record:run:${TRACK_RECORD_RUN_ID}`,
    async () => {
      const doc = await SignalRescoreRun.findOne({ runId: TRACK_RECORD_RUN_ID }).lean<Record<string, unknown>>();
      if (!doc) return null;
      const { _id, __v, loadedAt, ...rest } = doc;
      void _id;
      void __v;
      return trackRunSchema.parse({
        ...rest,
        loadedAt: loadedAt instanceof Date ? loadedAt.toISOString() : String(loadedAt),
      }) as TrackRun;
    },
    RUN_TTL_SECONDS
  );
}

/** Where the chart hands over from re-scored bars to the live record (see TrackRecordResponse.boundary). */
export function boundaryOf(symbol: SymbolTrack | null, interval: string): number | null {
  if (!symbol) return null;
  return symbol.liveSince ?? symbol.last + intervalToMs(interval);
}

interface LiveQuery {
  symbol: string;
  interval: string;
  style: TradingStyle;
  configVersion: number;
}

const liveMatch = (q: LiveQuery) => ({
  symbol: q.symbol,
  interval: q.interval,
  tradingStyle: q.style,
  configVersion: q.configVersion,
  ...sourceMatch('composite'),
});

/** Buy and sell tiers: the scheduler also writes outcomes for neutral bars, which are not calls. */
const CALL_TIERS = ['strong_buy', 'buy', 'sell', 'strong_sell'];

/** The scheduler's own resolved calls for the symbol and cell since the live start. */
export async function liveTrack(q: LiveQuery, since: number | null, costPercent: number): Promise<LiveTrack> {
  if (since === null) {
    return { since: null, resolved: 0, pending: 0, measures: pointMeasures([], costPercent) };
  }
  const calls = { ...liveMatch(q), tier: { $in: CALL_TIERS }, candleTimestamp: { $gte: since } };
  const [rows, pending] = await Promise.all([
    SignalOutcome.find({ ...calls, status: 'resolved' }, { _id: 0, tier: 1, forwardReturnPercent: 1 }).lean<
      Array<{ tier: string; forwardReturnPercent: number | null }>
    >(),
    SignalOutcome.countDocuments({ ...calls, status: 'pending' }),
  ]);
  const resolved = rows.filter(
    (r): r is { tier: string; forwardReturnPercent: number } =>
      typeof r.forwardReturnPercent === 'number' && Number.isFinite(r.forwardReturnPercent)
  );
  const measures = pointMeasures(resolved, costPercent);
  return { since, resolved: measures.calls, pending, measures };
}

interface BarsQuery extends LiveQuery {
  runId: string;
  from: number;
  to: number;
  boundary: number | null;
}

/**
 * Bars in [from, to]: re-scored bars strictly before the boundary, live bars
 * (any status) from it on. With no boundary the run has no rows for the
 * symbol, so only live bars can appear.
 */
export async function barsInRange(q: BarsQuery): Promise<TrackBar[]> {
  const bars: TrackBar[] = [];
  const rescoreTo = q.boundary === null ? q.from - 1 : Math.min(q.to, q.boundary - 1);
  if (rescoreTo >= q.from) {
    const docs = await SignalRescoreBar.find(
      {
        runId: q.runId,
        symbol: q.symbol,
        interval: q.interval,
        tradingStyle: q.style,
        // A bucket starts at most one month before its bars.
        bucketStart: { $gte: q.from - 31 * 86_400_000, $lte: rescoreTo },
      },
      { _id: 0, t: 1, score: 1, tier: 1, fwd: 1 }
    )
      .sort({ bucketStart: 1 })
      .lean<Array<{ t: number[]; score: number[]; tier: number[]; fwd: number[] }>>();
    for (const doc of docs) {
      for (let i = 0; i < doc.t.length; i++) {
        const t = doc.t[i];
        if (t < q.from || t > rescoreTo) continue;
        bars.push({ t, score: doc.score[i], tier: tierFromCode(doc.tier[i]), fwd: doc.fwd[i], source: 'rescore' });
      }
    }
  }
  const liveFrom = q.boundary === null ? q.from : Math.max(q.from, q.boundary);
  if (q.to >= liveFrom) {
    const live = await SignalOutcome.find(
      // Every status, listed so the planner gets point bounds on the
      // (tradingStyle, interval, status, candleTimestamp) index.
      { ...liveMatch(q), status: { $in: SIGNAL_OUTCOME_STATUSES }, candleTimestamp: { $gte: liveFrom, $lte: q.to } },
      { _id: 0, candleTimestamp: 1, score: 1, tier: 1, status: 1, forwardReturnPercent: 1 }
    )
      .sort({ candleTimestamp: 1 })
      .lean<
        Array<{ candleTimestamp: number; score: number; tier: SignalTier; status: string; forwardReturnPercent: number | null }>
      >();
    for (const row of live) {
      const resolved = row.status === 'resolved' && typeof row.forwardReturnPercent === 'number';
      bars.push({
        t: row.candleTimestamp,
        score: row.score,
        tier: row.tier,
        fwd: resolved ? row.forwardReturnPercent : null,
        source: 'live',
      });
    }
  }
  return bars;
}
