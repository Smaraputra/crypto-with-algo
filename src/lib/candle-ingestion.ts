import { Candle, type ICandle } from '@/lib/models/candle';
import { fetchKlinesRange } from '@/lib/binance';
import { connectDB } from '@/lib/mongodb';
import type { OHLCV } from '@/types/market';

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

export interface CandleRangeInfo {
  oldest: number | null;
  newest: number | null;
  count: number;
}

export interface BackfillProgress {
  fetched: number;
  inserted: number;
  symbol: string;
  interval: string;
}

/**
 * Fetch historical candles from Binance and bulk-upsert into MongoDB.
 * Checks existing data to avoid re-fetching already-stored ranges.
 */
export async function backfillCandles(
  symbol: string,
  interval: string,
  months = 24,
  onProgress?: (progress: BackfillProgress) => void
): Promise<{ inserted: number; total: number }> {
  await connectDB();

  const endTime = Date.now();
  const startTime = endTime - months * MS_PER_MONTH;

  // Check what we already have
  const existing = await getCandleRange(symbol, interval);

  const fetchStart = startTime;
  const fetchEnd = endTime;

  // If we have data, only fetch missing ranges
  // Simple strategy: fetch from startTime to oldest existing, and from newest existing to now
  const candles: OHLCV[] = [];

  if (existing.oldest !== null && existing.newest !== null) {
    // Fetch gap before existing data
    if (fetchStart < existing.oldest) {
      const older = await fetchKlinesRange(
        symbol,
        interval,
        fetchStart,
        existing.oldest - 1,
        (fetched) =>
          onProgress?.({ fetched, inserted: 0, symbol, interval })
      );
      candles.push(...older);
    }

    // Fetch gap after existing data
    if (existing.newest < fetchEnd) {
      const newer = await fetchKlinesRange(
        symbol,
        interval,
        existing.newest + 1,
        fetchEnd,
        (fetched) =>
          onProgress?.({
            fetched: candles.length + fetched,
            inserted: 0,
            symbol,
            interval,
          })
      );
      candles.push(...newer);
    }
  } else {
    // No existing data, fetch entire range
    const all = await fetchKlinesRange(
      symbol,
      interval,
      fetchStart,
      fetchEnd,
      (fetched) =>
        onProgress?.({ fetched, inserted: 0, symbol, interval })
    );
    candles.push(...all);
  }

  if (candles.length === 0) {
    return { inserted: 0, total: existing.count };
  }

  const inserted = await bulkUpsertCandles(symbol, interval, candles);

  onProgress?.({ fetched: candles.length, inserted, symbol, interval });

  const finalCount = existing.count + inserted;
  return { inserted, total: finalCount };
}

/**
 * Incremental sync: fetch candles from latest stored to now.
 */
export async function syncCandles(
  symbol: string,
  interval: string
): Promise<{ inserted: number }> {
  await connectDB();

  const range = await getCandleRange(symbol, interval);

  if (range.newest === null) {
    // No data at all -- do a short backfill (1 month)
    const result = await backfillCandles(symbol, interval, 1);
    return { inserted: result.inserted };
  }

  const startTime = range.newest + 1;
  const endTime = Date.now();

  if (startTime >= endTime) {
    return { inserted: 0 };
  }

  const candles = await fetchKlinesRange(symbol, interval, startTime, endTime);

  if (candles.length === 0) {
    return { inserted: 0 };
  }

  const inserted = await bulkUpsertCandles(symbol, interval, candles);
  return { inserted };
}

/**
 * Read candles from MongoDB. Does NOT trigger backfill.
 */
export async function getCandles(
  symbol: string,
  interval: string,
  startTime?: number,
  endTime?: number,
  limit = 500
): Promise<OHLCV[]> {
  await connectDB();

  const filter: Record<string, unknown> = { symbol, interval };

  if (startTime !== undefined || endTime !== undefined) {
    const timestampFilter: Record<string, number> = {};
    if (startTime !== undefined) timestampFilter.$gte = startTime;
    if (endTime !== undefined) timestampFilter.$lte = endTime;
    filter.timestamp = timestampFilter;
  }

  const docs: ICandle[] = await Candle.find(filter)
    .sort({ timestamp: 1 })
    .limit(limit)
    .lean();

  return docs.map((d) => ({
    timestamp: d.timestamp,
    open: d.open,
    high: d.high,
    low: d.low,
    close: d.close,
    volume: d.volume,
  }));
}

/**
 * Returns metadata about stored candles for a symbol/interval pair.
 */
export async function getCandleRange(
  symbol: string,
  interval: string
): Promise<CandleRangeInfo> {
  await connectDB();

  const [oldest, newest, count] = await Promise.all([
    Candle.findOne({ symbol, interval })
      .sort({ timestamp: 1 })
      .select('timestamp')
      .lean(),
    Candle.findOne({ symbol, interval })
      .sort({ timestamp: -1 })
      .select('timestamp')
      .lean(),
    Candle.countDocuments({ symbol, interval }),
  ]);

  return {
    oldest: oldest?.timestamp ?? null,
    newest: newest?.timestamp ?? null,
    count,
  };
}

/**
 * Bulk upsert candles into MongoDB. Returns number of upserted documents.
 */
async function bulkUpsertCandles(
  symbol: string,
  interval: string,
  candles: OHLCV[]
): Promise<number> {
  if (candles.length === 0) return 0;

  const ops = candles.map((c) => ({
    updateOne: {
      filter: { symbol, interval, timestamp: c.timestamp },
      update: {
        $set: {
          symbol,
          interval,
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        },
      },
      upsert: true,
    },
  }));

  const result = await Candle.bulkWrite(ops, { ordered: false });
  return result.upsertedCount;
}
