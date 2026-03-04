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
import { fetchFearGreedIndex } from '@/lib/sentiment-analysis';
import type { IHistoricalSnapshot } from '@/lib/models/historical-snapshot';
import { z } from 'zod';

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

    // Fetch Fear & Greed once for reference
    const fearGreedData = await fetchFearGreedIndex();

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

          // Fetch historical data
          const [fundingRates, longShortRatios, openInterestHist] =
            await Promise.allSettled([
              fetchFundingRate(symbol, limit),
              fetchLongShortRatio(symbol, interval, limit),
              fetchOpenInterestHistory(symbol, interval, limit),
            ]);

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

            // Find matching funding rate
            if (fundingRates.status === 'fulfilled') {
              const fr = fundingRates.value.find(
                f => Math.abs(f.fundingTime - timestamp) < intervalMs
              );
              if (fr) {
                data.fundingRate = {
                  rate: fr.fundingRate,
                  markPrice: fr.markPrice,
                };
              }
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

            // Use current Fear & Greed (historical data not easily available)
            if (fearGreedData) {
              data.fearGreed = {
                index: fearGreedData.value,
                label: fearGreedData.valueClassification,
              };
            }

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
    });
  } catch (error) {
    console.error('Backfill failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Backfill failed' },
      { status: 500 }
    );
  }
}
