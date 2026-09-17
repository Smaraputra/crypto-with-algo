/**
 * Historical snapshot construction for the admin backfill.
 *
 * The first backfill took its bar timestamps from the long/short ratio
 * response, which Binance caps at 500 bars (about 30 days at 1h), so a request
 * for 48 months still wrote at most 500 bars. Funding was a single 1,000-event
 * call, about 333 days. Optimization windows reach 12 to 48 months, and bars
 * without Fear & Greed and funding score far wider than live bars do (see
 * src/lib/signals/calibration.ts), so every bar of the window is generated here
 * and funding history is paged to cover it.
 *
 * Open interest and long/short ratio remain limited to what Binance still
 * serves. Bars older than that get neither, which the scorer treats as missing.
 */
import { alignTimestamp, bulkUpsertSnapshots } from '@/lib/historical-snapshots';
import { fetchFundingRate, fetchLongShortRatio, fetchOpenInterestHistory } from '@/lib/binance-futures';
import { fetchFearAndGreedHistory } from '@/lib/external/fear-greed';
import { intervalToMs } from '@/lib/intervals';
import type { FundingRate, LongShortRatio, OpenInterestHist } from '@/types/futures';
import type { IHistoricalSnapshot } from '@/lib/models/historical-snapshot';

/** A funding event settles every 8h; beyond that plus one bar it is stale. */
export const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

const FUNDING_PAGE_SIZE = 1000;
/** 60 pages is about 55 years of 8-hourly events: a runaway guard, not a budget. */
const MAX_FUNDING_PAGES = 60;

/** The type fetchFundingHistory resolves with, named for callers outside this module. */
export type FundingEvent = FundingRate;

const DAY_MS = 24 * 60 * 60 * 1000;
// Binance serves long/short and open interest history only this far back
const RECENT_FUTURES_LIMIT = 500;
// Bars per bulk write; 48 months of 15m bars is about 140,000
const UPSERT_CHUNK = 5000;
// Carry a daily Fear & Greed reading forward at most this many days over gaps
export const MAX_FEAR_GREED_CARRY_DAYS = 3;

export interface BackfillSnapshot {
  symbol: string;
  interval: string;
  timestamp: number;
  data: IHistoricalSnapshot['data'];
}

export interface BackfillCoverage {
  fundingRate: number;
  longShortRatio: number;
  openInterest: number;
  fearGreed: number;
}

/**
 * Every funding event in [startTime, endTime], oldest first. Binance returns at
 * most 1,000 events per call counting forward from startTime, so the cursor
 * advances past the last event until a short page arrives.
 */
export async function fetchFundingHistory(
  symbol: string,
  startTime: number,
  endTime: number
): Promise<FundingRate[]> {
  const byTime = new Map<number, FundingRate>();
  let cursor = startTime;

  for (let page = 0; page < MAX_FUNDING_PAGES; page++) {
    const events = await fetchFundingRate(symbol, FUNDING_PAGE_SIZE, cursor, endTime);
    for (const event of events) {
      byTime.set(event.fundingTime, event);
    }
    if (events.length < FUNDING_PAGE_SIZE) break;

    const next = Math.max(...events.map((e) => e.fundingTime)) + 1;
    if (next <= cursor || next > endTime) break;
    cursor = next;
  }

  return Array.from(byTime.values()).sort((a, b) => a.fundingTime - b.fundingTime);
}

function lastFundingAtOrBefore(sorted: FundingRate[], ts: number): FundingRate | null {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].fundingTime <= ts) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? sorted[ans] : null;
}

/**
 * One snapshot per bar from the first bar starting at or after startTime to the
 * bar containing endTime, aligned exactly as live ingestion aligns them so the
 * merge-upsert lands on the same documents.
 */
export function buildBackfillSnapshots(input: {
  symbol: string;
  interval: string;
  startTime: number;
  endTime: number;
  fundingEvents: FundingRate[];
  longShortRatios: LongShortRatio[];
  openInterest: OpenInterestHist[];
  fearGreedAt: (ts: number) => { index: number; label: string } | null;
}): { snapshots: BackfillSnapshot[]; coverage: BackfillCoverage } {
  const { symbol, interval, startTime, endTime, fearGreedAt } = input;
  const intervalMs = intervalToMs(interval);
  const fundingEvents = [...input.fundingEvents].sort((a, b) => a.fundingTime - b.fundingTime);
  const fundingStalenessMs = FUNDING_INTERVAL_MS + intervalMs;
  const longShortByTime = new Map(input.longShortRatios.map((ls) => [ls.timestamp, ls]));
  const openInterestByTime = new Map(input.openInterest.map((oi) => [oi.timestamp, oi]));

  let first = alignTimestamp(startTime, interval);
  if (first < startTime) first += intervalMs;
  const last = alignTimestamp(endTime, interval);

  const snapshots: BackfillSnapshot[] = [];
  const coverage: BackfillCoverage = { fundingRate: 0, longShortRatio: 0, openInterest: 0, fearGreed: 0 };

  for (let timestamp = first; timestamp <= last; timestamp += intervalMs) {
    const data: IHistoricalSnapshot['data'] = {};

    // Carry the last settled funding event forward, mirroring the live path
    // (which reads the latest settled rate), capped for staleness
    const fr = lastFundingAtOrBefore(fundingEvents, timestamp);
    if (fr && timestamp - fr.fundingTime <= fundingStalenessMs) {
      // Older funding events carry an empty markPrice, which parses to NaN and
      // fails the schema cast for the whole batch; omit it instead.
      data.fundingRate = Number.isFinite(fr.markPrice)
        ? { rate: fr.fundingRate, markPrice: fr.markPrice }
        : { rate: fr.fundingRate };
      coverage.fundingRate++;
    }

    const ls = longShortByTime.get(timestamp);
    if (ls) {
      data.longShortRatio = {
        ratio: ls.longShortRatio,
        longAccount: ls.longAccount,
        shortAccount: ls.shortAccount,
      };
      coverage.longShortRatio++;
    }

    const oi = openInterestByTime.get(timestamp);
    if (oi) {
      data.openInterest = { value: oi.sumOpenInterest, sumValue: oi.sumOpenInterestValue };
      coverage.openInterest++;
    }

    const fg = fearGreedAt(timestamp);
    if (fg) {
      data.fearGreed = { index: fg.index, label: fg.label };
      coverage.fearGreed++;
    }

    snapshots.push({ symbol, interval, timestamp, data });
  }

  return { snapshots, coverage };
}

export interface SnapshotBackfillPairResult {
  snapshots: number;
  coverage: BackfillCoverage;
}

/**
 * Backfill one symbol/interval pair: fetches the recent long/short and open
 * interest history Binance still serves, builds a snapshot for every bar of
 * the window with {@link buildBackfillSnapshots}, and upserts them in chunks.
 *
 * Funding events and the Fear & Greed lookup are supplied by the caller,
 * since both are shared across every interval of a symbol (funding) or across
 * the whole run (Fear & Greed) rather than fetched per pair.
 */
export async function backfillSnapshotRange(input: {
  symbol: string;
  interval: string;
  startTime: number;
  endTime: number;
  fundingEvents: FundingEvent[];
  fearGreedAt: (ts: number) => { index: number; label: string } | null;
}): Promise<SnapshotBackfillPairResult> {
  const { symbol, interval, startTime, endTime, fundingEvents, fearGreedAt } = input;

  const [longShort, openInterest] = await Promise.allSettled([
    fetchLongShortRatio(symbol, interval, RECENT_FUTURES_LIMIT),
    fetchOpenInterestHistory(symbol, interval, RECENT_FUTURES_LIMIT),
  ]);

  const built = buildBackfillSnapshots({
    symbol,
    interval,
    startTime,
    endTime,
    fundingEvents,
    longShortRatios: longShort.status === 'fulfilled' ? longShort.value : [],
    openInterest: openInterest.status === 'fulfilled' ? openInterest.value : [],
    fearGreedAt,
  });

  for (let i = 0; i < built.snapshots.length; i += UPSERT_CHUNK) {
    await bulkUpsertSnapshots(built.snapshots.slice(i, i + UPSERT_CHUNK));
  }

  return { snapshots: built.snapshots.length, coverage: built.coverage };
}

/**
 * Loads a point-in-time Fear & Greed lookup covering `days` back from today.
 * The index is daily, so one reading maps onto every intra-day bar of its UTC
 * day; a gap in the feed carries the last known reading forward for up to
 * {@link MAX_FEAR_GREED_CARRY_DAYS} days before giving up. Missing data is a
 * gap, not a failure: if the fetch itself fails, the returned lookup always
 * answers null (logged once here) rather than throwing for every bar.
 */
export async function loadFearGreedLookup(
  days: number
): Promise<(ts: number) => { index: number; label: string } | null> {
  const fearGreedByDay = new Map<number, { index: number; label: string }>();

  try {
    const history = await fetchFearAndGreedHistory(days);
    for (const entry of history) {
      const day = Math.floor(entry.timestamp / DAY_MS) * DAY_MS;
      fearGreedByDay.set(day, { index: entry.fearGreedIndex, label: entry.label });
    }
  } catch (error) {
    console.error(
      'Failed to fetch Fear & Greed history:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    return () => null;
  }

  return (ts: number): { index: number; label: string } | null => {
    const day = Math.floor(ts / DAY_MS) * DAY_MS;
    for (let back = 0; back <= MAX_FEAR_GREED_CARRY_DAYS; back++) {
      const hit = fearGreedByDay.get(day - back * DAY_MS);
      if (hit) return hit;
    }
    return null;
  };
}
