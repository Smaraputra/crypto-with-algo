import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, adminAuthError, adminAuthStatus } from '@/lib/admin-auth';
import { connectDB } from '@/lib/mongodb';
import {
  backfillSnapshotRange,
  fetchFundingHistory,
  loadFearGreedLookup,
  MAX_FEAR_GREED_CARRY_DAYS,
  type BackfillCoverage,
} from '@/lib/snapshot-backfill';
import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Bars this dense over a long window would be an enormous document count. */
const CAPPED_MONTHS_MAX = 12;

const backfillSchema = z
  .object({
    symbols: z.array(z.string()).min(1).max(20),
    intervals: z.array(z.enum(['15m', '1h', '4h', '1d'])),
    months: z.number().min(1).max(120),
  })
  .superRefine((data, ctx) => {
    if (data.months > CAPPED_MONTHS_MAX && data.intervals.includes('15m')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '15m is limited to 12 months',
        path: ['months'],
      });
    }
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
    const fearGreedAt = await loadFearGreedLookup(months * 31 + MAX_FEAR_GREED_CARRY_DAYS);

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
          const result = await backfillSnapshotRange({
            symbol,
            interval,
            startTime,
            endTime,
            fundingEvents,
            fearGreedAt,
          });

          totalIngested += result.snapshots;
          coverage.fundingRate += result.coverage.fundingRate;
          coverage.longShortRatio += result.coverage.longShortRatio;
          coverage.openInterest += result.coverage.openInterest;
          coverage.fearGreed += result.coverage.fearGreed;
          console.log(`Backfilled ${result.snapshots} snapshots for ${symbol} ${interval}`);

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
