import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import {
  alignTimestamp,
  bulkUpsertSnapshots,
} from '@/lib/historical-snapshots';
import {
  fetchFundingRate,
  fetchLongShortRatio,
  fetchOpenInterestHistory,
} from '@/lib/binance-futures';
import { fetchFearAndGreedHistory } from '@/lib/external/fear-greed';
import type { FundingRate } from '@/types/futures';
import type { IHistoricalSnapshot } from '@/lib/models/historical-snapshot';
import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;
// A funding event settles every 8h; beyond that plus one bar it is stale
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
// Carry a daily Fear & Greed reading forward at most this many days over gaps
const MAX_FEAR_GREED_CARRY_DAYS = 3;

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

const backfillSchema = z.object({
  symbols: z.array(z.string()).min(1).max(20),
  intervals: z.array(z.enum(['15m', '1h', '4h', '1d'])),
  months: z.number().min(1).max(12),
});

/**
 * Admin endpoint to backfill historical snapshots
 * WARNING: This can make many API calls - use carefully to avoid rate limits
 */
export async function POST(req: NextRequest) {
  try {
    // Auth check - must be admin
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!session.user.email || session.user.email !== process.env.ADMIN_EMAIL) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const parsed = backfillSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const { symbols, intervals, months } = parsed.data;

    await connectDB();

    const endTime = Date.now();
    const startTime = endTime - months * 30 * 24 * 60 * 60 * 1000;

    let totalIngested = 0;
    let totalErrors = 0;
    const coverage = { fundingRate: 0, longShortRatio: 0, openInterest: 0, fearGreed: 0 };

    // Point-in-time Fear & Greed: the index is daily, so one reading maps onto
    // every intra-day bar of its UTC day. That daily-onto-intraday mapping is
    // the honest best available granularity. Missing data is a gap, not a failure.
    const fearGreedByDay = new Map<number, { index: number; label: string }>();
    try {
      const history = await fetchFearAndGreedHistory(months * 31);
      for (const entry of history) {
        const day = Math.floor(entry.timestamp / DAY_MS) * DAY_MS;
        fearGreedByDay.set(day, { index: entry.fearGreedIndex, label: entry.label });
      }
    } catch (error) {
      console.error('Failed to fetch Fear & Greed history:', error instanceof Error ? error.message : 'Unknown error');
    }

    const fearGreedAt = (ts: number): { index: number; label: string } | null => {
      const day = Math.floor(ts / DAY_MS) * DAY_MS;
      for (let back = 0; back <= MAX_FEAR_GREED_CARRY_DAYS; back++) {
        const hit = fearGreedByDay.get(day - back * DAY_MS);
        if (hit) return hit;
      }
      return null;
    };

    for (const symbol of symbols) {
      for (const interval of intervals) {
        try {
          console.log(`Backfilling ${symbol} ${interval}...`);

          // Calculate interval milliseconds
          let intervalMs = 0;
          switch (interval) {
            case '15m':
              intervalMs = 15 * 60 * 1000;
              break;
            case '1h':
              intervalMs = 60 * 60 * 1000;
              break;
            case '4h':
              intervalMs = 4 * 60 * 60 * 1000;
              break;
            case '1d':
              intervalMs = 24 * 60 * 60 * 1000;
              break;
          }

          const numBars = Math.floor((endTime - startTime) / intervalMs);

          // For MVP, we'll fetch recent historical data only
          // Binance futures endpoints have limits on how far back we can query
          const limit = Math.min(numBars, 500); // Max 500 per request

          // Fetch historical data. Funding settles 8-hourly, so a ranged call
          // covers the window (1000 events ~ 333 days); long/short history is
          // limited by Binance to ~30 days - older bars stay gap-honest nulls.
          const [fundingRates, longShortRatios, openInterestHist] =
            await Promise.allSettled([
              fetchFundingRate(symbol, 1000, startTime),
              fetchLongShortRatio(symbol, interval, limit),
              fetchOpenInterestHistory(symbol, interval, limit),
            ]);

          const fundingEvents: FundingRate[] =
            fundingRates.status === 'fulfilled'
              ? [...fundingRates.value].sort((a, b) => a.fundingTime - b.fundingTime)
              : [];
          const fundingStalenessMs = FUNDING_INTERVAL_MS + intervalMs;

          // Build snapshots for each timestamp
          const snapshots: Array<{
            symbol: string;
            interval: string;
            timestamp: number;
            data: IHistoricalSnapshot['data'];
          }> = [];

          // Use long/short ratio timestamps as baseline (most granular)
          let timestamps: number[] = [];

          if (longShortRatios.status === 'fulfilled') {
            timestamps = longShortRatios.value.map(ls => ls.timestamp);
          } else {
            // Fallback: generate timestamps manually
            for (let i = 0; i < limit; i++) {
              const ts = alignTimestamp(endTime - i * intervalMs, interval);
              timestamps.push(ts);
            }
          }

          for (const timestamp of timestamps) {
            const data: IHistoricalSnapshot['data'] = {};

            // Carry the last settled funding event forward, mirroring the live
            // path (which reads the latest settled rate), capped for staleness
            const fr = lastFundingAtOrBefore(fundingEvents, timestamp);
            if (fr && timestamp - fr.fundingTime <= fundingStalenessMs) {
              data.fundingRate = {
                rate: fr.fundingRate,
                markPrice: fr.markPrice,
              };
            }

            // Find matching long/short ratio
            if (longShortRatios.status === 'fulfilled') {
              const ls = longShortRatios.value.find(
                l => l.timestamp === timestamp
              );
              if (ls) {
                data.longShortRatio = {
                  ratio: ls.longShortRatio,
                  longAccount: ls.longAccount,
                  shortAccount: ls.shortAccount,
                };
              }
            }

            // Find matching open interest
            if (openInterestHist.status === 'fulfilled') {
              const oi = openInterestHist.value.find(
                o => o.timestamp === timestamp
              );
              if (oi) {
                data.openInterest = {
                  value: oi.sumOpenInterest,
                  sumValue: oi.sumOpenInterestValue,
                };
              }
            }

            // Point-in-time Fear & Greed for this bar's UTC day
            const fg = fearGreedAt(timestamp);
            if (fg) {
              data.fearGreed = { index: fg.index, label: fg.label };
            }

            if (data.fundingRate) coverage.fundingRate++;
            if (data.longShortRatio) coverage.longShortRatio++;
            if (data.openInterest) coverage.openInterest++;
            if (data.fearGreed) coverage.fearGreed++;

            snapshots.push({ symbol, interval, timestamp, data });
          }

          await bulkUpsertSnapshots(snapshots);
          totalIngested += snapshots.length;
          console.log(`Backfilled ${snapshots.length} snapshots for ${symbol} ${interval}`);

          // Rate limit pause (1 second between symbol/interval pairs)
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`Failed to backfill ${symbol} ${interval}:`, error instanceof Error ? error.message : 'Unknown error');
          totalErrors++;
        }
      }
    }

    return NextResponse.json({
      success: true,
      symbols: symbols.length,
      intervals: intervals.length,
      ingested: totalIngested,
      errors: totalErrors,
      coverage,
    });
  } catch (error) {
    console.error('Backfill failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Backfill failed' },
      { status: 500 }
    );
  }
}
