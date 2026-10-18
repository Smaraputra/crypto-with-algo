import type { KlineCsvRow } from '@/lib/external/binance-archive';
import { Candle } from '@/lib/models/candle';

/**
 * Writing spot bars into the live Candle collection.
 *
 * Candle is the live app's collection, and archive history must never
 * overwrite a live-written bar, so all writes here are insert-only ($setOnInsert).
 */

export const SPOT_WRITE_CHUNK = 5000;

export interface SpotCandleInsert {
  filter: { symbol: string; interval: string; timestamp: number };
  insert: {
    symbol: string;
    interval: string;
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    takerBuyVolume?: number;
  };
}

/** Archive spot rows as insert-only ops. takerBuyVolume only when finite. Never sets expiresAt. */
export function spotCandleInserts(
  symbol: string,
  interval: string,
  rows: KlineCsvRow[]
): SpotCandleInsert[] {
  return rows.map((row) => {
    const insert: SpotCandleInsert['insert'] = {
      symbol,
      interval,
      timestamp: row.timestamp,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    };
    if (row.takerBuyVolume !== null && Number.isFinite(row.takerBuyVolume)) {
      insert.takerBuyVolume = row.takerBuyVolume;
    }
    return {
      filter: { symbol, interval, timestamp: row.timestamp },
      insert,
    };
  });
}

/**
 * Insert-only writes into `Candle`: `updateOne` with `{ $setOnInsert: insert }` and `upsert: true`,
 * chunked by SPOT_WRITE_CHUNK, `ordered: false`. Returns the summed `upsertedCount`.
 * A row the live system already wrote is left exactly as it is.
 */
export async function bulkInsertSpotCandles(ops: SpotCandleInsert[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < ops.length; i += SPOT_WRITE_CHUNK) {
    const chunk = ops.slice(i, i + SPOT_WRITE_CHUNK);
    const result = await Candle.bulkWrite(
      chunk.map((op) => ({
        updateOne: { filter: op.filter, update: { $setOnInsert: op.insert }, upsert: true },
      })),
      { ordered: false }
    );
    written += result.upsertedCount ?? 0;
  }
  return written;
}
