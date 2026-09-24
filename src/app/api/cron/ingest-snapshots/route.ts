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
import { fetchFearAndGreed } from '@/lib/external/fear-greed';
import { fetchCryptoNews } from '@/lib/external/crypto-news';
import { NEWS_WINDOW_MS, filterByWindow } from '@/lib/external/rss-news';
import { analyzeNewsSentiment } from '@/lib/external/news-sentiment';
import type { SentimentData } from '@/types/signal';
import type { IHistoricalSnapshot } from '@/lib/models/historical-snapshot';

import { verifyCronSecret } from '@/lib/cron-auth';
import { withJobRun } from '@/lib/job-run';

/**
 * How many merged-feed items to consider before the window filter. Generous on
 * purpose: the news window should decide the sample, not the cap. The default
 * of 20 was small enough that the cap bound first, which is what let stale
 * items in once recent stories ran out.
 */
const NEWS_FETCH_LIMIT = 100;

/**
 * Ingest historical snapshots for active symbols
 * Query params:
 *   interval: "15m" | "1h" | "4h" | "1d" (required)
 */
async function handler(req: NextRequest) {
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
  const now = Date.now();
  const timestamp = alignTimestamp(now, interval);
  const newsFrom = now - NEWS_WINDOW_MS;

  // Fetch Fear & Greed once (same for all symbols); missing data is a gap, not a failure
  let fearGreedData: SentimentData | null = null;
  try {
    fearGreedData = await fetchFearAndGreed();
  } catch (error) {
    console.error('Failed to fetch Fear & Greed index:', error instanceof Error ? error.message : 'Unknown error');
  }

  const snapshots: Array<{
    symbol: string;
    interval: string;
    timestamp: number;
    data: IHistoricalSnapshot['data'];
  }> = [];

  let successCount = 0;
  let errorCount = 0;
  // Counted separately from errorCount, which only ever catches a throw in this
  // loop's own body. They mean different things: fetchErrors is an upstream
  // outage, errorCount is a bug here.
  let fetchErrors = 0;
  let skippedCount = 0;

  // Fetch data for each symbol
  for (const symbol of symbols) {
    try {
      const [fundingResult, longShortResult, openInterestResult, newsItems] =
        await Promise.allSettled([
          fetchFundingRate(symbol, 1),
          fetchLongShortRatio(symbol, interval, 1),
          fetchOpenInterest(symbol),
          fetchCryptoNews(symbol.replace(/USDT$/, ''), NEWS_FETCH_LIMIT),
        ]);

      // `Promise.allSettled` never rejects, so nothing above can reach the
      // catch below and `errors` was structurally stuck at 0: a total Binance
      // futures outage reported a clean `ingested: 10, errors: 0`. Count the
      // rejections that are already in hand.
      for (const settled of [fundingResult, longShortResult, openInterestResult, newsItems]) {
        if (settled.status === 'rejected') {
          fetchErrors++;
          console.error(
            `ingest-snapshots ${symbol}:`,
            settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
          );
        }
      }

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

      // News sentiment, over the recent window only.
      //
      // The merged feed is newest-first and was previously sliced to a flat 20
      // with no lower bound, so a symbol with two fresh stories still reported
      // count 20 and averaged its sentiment mostly over months-old evergreen
      // items. That inflated count past the `count >= 3` gate in scoreSentiment
      // and pulled avgSentiment toward whatever the feed's tail happened to
      // hold. Bounding the window first makes count a truthful measure of
      // recent news volume. A symbol with nothing recent stores no
      // newsSentiment at all rather than a false neutral, which the scorer
      // already handles by redistributing weight.
      if (newsItems.status === 'fulfilled') {
        const recent = filterByWindow(newsItems.value, newsFrom, now);
        if (recent.length > 0) {
          data.newsSentiment = analyzeNewsSentiment(recent);
        }
      }

      // Fear & Greed (same for all symbols)
      if (fearGreedData) {
        data.fearGreed = {
          index: fearGreedData.fearGreedIndex,
          label: fearGreedData.label,
        };
      }

      // A symbol whose every per-symbol source failed still reached the push,
      // and `mergeSnapshotUpdate` then `$setOnInsert`s `data: {}` -- a row that
      // counts as a snapshot to any coverage query while carrying nothing.
      //
      // The emptiness test must be over the PER-SYMBOL fields, not
      // `Object.keys(data)`: Fear & Greed is market-wide and is written into
      // every symbol's data below, so whenever it succeeds `data` is non-empty
      // for a symbol about which nothing was learned.
      const hasSymbolData =
        data.fundingRate !== undefined ||
        data.longShortRatio !== undefined ||
        data.openInterest !== undefined ||
        data.newsSentiment !== undefined;

      if (!hasSymbolData) {
        skippedCount++;
        continue;
      }

      snapshots.push({ symbol, interval, timestamp, data });
      successCount++;
    } catch (error) {
      console.error(`Failed to fetch data for ${symbol}:`, error instanceof Error ? error.message : 'Unknown error');
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
    // Symbols whose per-symbol sources all failed, so nothing was stored for
    // them. Distinguishes "ran and learned nothing" from "ran and stored data".
    skipped: skippedCount,
    fetchErrors,
    errors: errorCount,
  });
}

// The handler body is unchanged; the wrapper only records that the run
// happened and what it returned. A 401 writes nothing.
export const GET = withJobRun((req) => `ingest-snapshots:${new URL(req.url).searchParams.get('interval') ?? 'unknown'}`, handler);
