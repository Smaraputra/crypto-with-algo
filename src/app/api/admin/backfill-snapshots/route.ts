import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, adminAuthError, adminAuthStatus } from '@/lib/admin-auth';
import { connectDB } from '@/lib/mongodb';
import { bulkUpsertSnapshots } from '@/lib/historical-snapshots';
import { fetchLongShortRatio, fetchOpenInterestHistory } from '@/lib/binance-futures';
import { fetchFearAndGreedHistory } from '@/lib/external/fear-greed';
import {
  buildBackfillSnapshots,
  fetchFundingHistory,
  type BackfillCoverage,
} from '@/lib/snapshot-backfill';
import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;
// Carry a daily Fear & Greed reading forward at most this many days over gaps
const MAX_FEAR_GREED_CARRY_DAYS = 3;
// Binance serves long/short and open interest history only this far back
const RECENT_FUTURES_LIMIT = 500;
// Bars per bulk write; 48 months of 15m bars is about 140,000
const UPSERT_CHUNK = 5000;

const backfillSchema = z.object({
  symbols: z.array(z.string()).min(1).max(20),
  intervals: z.array(z.enum(['15m', '1h', '4h', '1d'])),
  months: z.number().min(1).max(48),
});

/**
 * Admin endpoint to backfill historical snapshots.
 *
 * Writes one snapshot for every bar in the window. Upserts merge field by field,
 * so bars already captured live keep their news, open interest, and long/short
 * data. WARNING: pages funding history per symbol; scope requests sensibly.
 */
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    if (!admin.ok) {
      return NextResponse.json(adminAuthError(admin), { status: adminAuthStatus(admin) });
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
    const startTime = endTime - months * 30 * DAY_MS;

    let totalIngested = 0;
    let totalErrors = 0;
    const coverage: BackfillCoverage = { fundingRate: 0, longShortRatio: 0, openInterest: 0, fearGreed: 0 };

    // Point-in-time Fear & Greed: the index is daily, so one reading maps onto
    // every intra-day bar of its UTC day. Missing data is a gap, not a failure.
    const fearGreedByDay = new Map<number, { index: number; label: string }>();
    try {
      const history = await fetchFearAndGreedHistory(months * 31 + MAX_FEAR_GREED_CARRY_DAYS);
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
      // Funding is per symbol, not per interval: page it once.
      let fundingEvents: Awaited<ReturnType<typeof fetchFundingHistory>> = [];
      try {
        fundingEvents = await fetchFundingHistory(symbol, startTime - 8 * 60 * 60 * 1000, endTime);
      } catch (error) {
        console.error(`Failed to fetch funding history for ${symbol}:`, error instanceof Error ? error.message : 'Unknown error');
      }

      for (const interval of intervals) {
        try {
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

          totalIngested += built.snapshots.length;
          coverage.fundingRate += built.coverage.fundingRate;
          coverage.longShortRatio += built.coverage.longShortRatio;
          coverage.openInterest += built.coverage.openInterest;
          coverage.fearGreed += built.coverage.fearGreed;
          console.log(`Backfilled ${built.snapshots.length} snapshots for ${symbol} ${interval}`);

          // Rate limit pause between symbol/interval pairs
          await new Promise((resolve) => setTimeout(resolve, 1000));
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
    return NextResponse.json({ error: 'Backfill failed' }, { status: 500 });
  }
}
