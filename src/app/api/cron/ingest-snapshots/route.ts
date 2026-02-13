import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import {
  alignTimestamp,
  bulkUpsertSnapshots,
  getActiveSymbols,
} from '@/lib/historical-snapshots';
import {
  fetchFundingRate,
  fetchLongShortRatio,
  fetchOpenInterest,
} from '@/lib/binance-futures';
import {
  fetchFearGreedIndex,
  fetchCryptoNews,
  analyzeNewsSentiment,
} from '@/lib/sentiment-analysis';
import type { IHistoricalSnapshot } from '@/lib/models/historical-snapshot';

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

/**
 * Ingest historical snapshots for active symbols
 * Query params:
 *   interval: "15m" | "1h" | "4h" | "1d" (required)
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const interval = searchParams.get('interval');

  if (!interval || !['15m', '1h', '4h', '1d'].includes(interval)) {
    return NextResponse.json(
      { error: 'Invalid interval parameter' },
      { status: 400 }
    );
  }

  await connectDB();

  const symbols = await getActiveSymbols();
  const timestamp = alignTimestamp(Date.now(), interval);

  // Fetch Fear & Greed once (same for all symbols)
  const fearGreedData = await fetchFearGreedIndex();

  const snapshots: Array<{
    symbol: string;
    interval: string;
    timestamp: number;
    data: IHistoricalSnapshot['data'];
  }> = [];

  let successCount = 0;
  let errorCount = 0;

  // Fetch data for each symbol
  for (const symbol of symbols) {
    try {
      const [fundingResult, longShortResult, openInterestResult, newsItems] =
        await Promise.allSettled([
          fetchFundingRate(symbol, 1),
          fetchLongShortRatio(symbol, interval, 1),
          fetchOpenInterest(symbol),
          fetchCryptoNews(symbol),
        ]);

      const data: IHistoricalSnapshot['data'] = {};

      // Funding rate
      if (fundingResult.status === 'fulfilled' && fundingResult.value.length > 0) {
        const fr = fundingResult.value[0];
        data.fundingRate = {
          rate: fr.fundingRate,
          markPrice: fr.markPrice,
        };
      }

      // Long/short ratio
      if (longShortResult.status === 'fulfilled' && longShortResult.value.length > 0) {
        const ls = longShortResult.value[0];
        data.longShortRatio = {
          ratio: ls.longShortRatio,
          longAccount: ls.longAccount,
          shortAccount: ls.shortAccount,
        };
      }

      // Open interest
      if (openInterestResult.status === 'fulfilled') {
        const oi = openInterestResult.value;
        data.openInterest = {
          value: oi.openInterest,
          sumValue: oi.openInterest, // Same for spot OI
        };
      }

      // News sentiment
      if (newsItems.status === 'fulfilled' && newsItems.value.length > 0) {
        const sentiment = analyzeNewsSentiment(newsItems.value);
        data.newsSentiment = sentiment;
      }

      // Fear & Greed (same for all symbols)
      if (fearGreedData) {
        data.fearGreed = {
          index: fearGreedData.value,
          label: fearGreedData.valueClassification,
        };
      }

      snapshots.push({ symbol, interval, timestamp, data });
      successCount++;
    } catch (error) {
      console.error(`Failed to fetch data for ${symbol}:`, error);
      errorCount++;
    }
  }

  // Bulk upsert all snapshots
  if (snapshots.length > 0) {
    await bulkUpsertSnapshots(snapshots);
  }

  return NextResponse.json({
    interval,
    timestamp,
    symbols: symbols.length,
    ingested: successCount,
    errors: errorCount,
  });
}
