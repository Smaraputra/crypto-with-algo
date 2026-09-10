import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, adminAuthError, adminAuthStatus } from '@/lib/admin-auth';
import { connectDB } from '@/lib/mongodb';
import { backfillCandles, getCandleRange } from '@/lib/candle-ingestion';
import { Candle, HF_INTERVALS } from '@/lib/models/candle';

/**
 * Intervals worth backfilling. 1m and 5m are excluded: they carry a TTL
 * (HF_TTL_MS), so history fetched beyond that horizon is deleted again by the
 * TTL index and the request would burn Binance quota for nothing.
 */
const DURABLE_INTERVALS = ['15m', '1h', '4h', '1d'] as const;

const backfillSchema = z.object({
  symbols: z.array(z.string()).min(1).max(20),
  intervals: z.array(z.enum(DURABLE_INTERVALS)).min(1),
  months: z.number().min(1).max(48),
  /**
   * Re-fetch bars already stored rather than only the gaps around them. Needed
   * to add fields introduced after those rows were written, such as
   * takerBuyVolume.
   */
  refill: z.boolean().optional(),
});

/** One second between pairs, matching the snapshot backfill's pacing. */
const PAIR_DELAY_MS = 1000;

/**
 * Admin endpoint to backfill or repair stored candles.
 *
 * WARNING: a refill re-requests every bar in the window for each pair, so this
 * can make a great many Binance calls. Scope it to the symbols you need.
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

    const { symbols, intervals, months, refill = false } = parsed.data;

    await connectDB();

    let totalInserted = 0;
    let totalErrors = 0;
    const results: Array<{
      symbol: string;
      interval: string;
      inserted: number;
      total: number;
      withTakerVolume: number;
    }> = [];

    for (const symbol of symbols) {
      for (const interval of intervals) {
        try {
          const { inserted } = await backfillCandles(symbol, interval, months, { refill });

          // A refill patches existing rows, so `inserted` is 0 even on success.
          // Report the field the refill exists to populate instead.
          const [range, withTakerVolume] = await Promise.all([
            getCandleRange(symbol, interval),
            Candle.countDocuments({ symbol, interval, takerBuyVolume: { $exists: true } }),
          ]);

          totalInserted += inserted;
          results.push({
            symbol,
            interval,
            inserted,
            total: range.count,
            withTakerVolume,
          });

          await new Promise((resolve) => setTimeout(resolve, PAIR_DELAY_MS));
        } catch (error) {
          console.error(
            `Failed to backfill candles for ${symbol} ${interval}:`,
            error instanceof Error ? error.message : 'Unknown error'
          );
          totalErrors++;
        }
      }
    }

    return NextResponse.json({
      success: true,
      refill,
      months,
      inserted: totalInserted,
      errors: totalErrors,
      // Stated so a caller is not left wondering why 1m/5m were ignored.
      excludedIntervals: HF_INTERVALS,
      results,
    });
  } catch (error) {
    console.error(
      'Candle backfill failed:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json({ error: 'Candle backfill failed' }, { status: 500 });
  }
}
