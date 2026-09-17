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
import { alignTimestamp } from '@/lib/historical-snapshots';
import { fetchFundingRate } from '@/lib/binance-futures';
import { intervalToMs } from '@/lib/intervals';
import type { FundingRate, LongShortRatio, OpenInterestHist } from '@/types/futures';
import type { IHistoricalSnapshot } from '@/lib/models/historical-snapshot';

/** A funding event settles every 8h; beyond that plus one bar it is stale. */
export const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

const FUNDING_PAGE_SIZE = 1000;
/** 60 pages is about 55 years of 8-hourly events: a runaway guard, not a budget. */
const MAX_FUNDING_PAGES = 60;

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
