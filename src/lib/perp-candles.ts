import type { PerpCandleFields, UpsertOp } from '@/lib/archive-ingestion';
import { PerpCandle } from '@/lib/models/perp-candle';

/**
 * Writing perpetual bars, shared by the bulk CLI and the daily cron route.
 *
 * It lives here rather than inside either caller for the reason
 * `bulkUpsertSnapshots` in `historical-snapshots.ts` does: two writers that
 * shape the same upsert by hand are two writers that can drift, and a drift
 * here would be silent because nothing in the live app reads this collection.
 */

/**
 * Documents per `bulkWrite`.
 *
 * A day of 5m klines is 288 rows, so the chunking never binds for the cron
 * route; it exists for the bulk path, where a month of 5m bars is about 8,900
 * rows and a year about 105,000. The archive's memory blow-up on bookDepth
 * (`scripts/ops/ingest-archive.ts`'s header) was in holding whole jobs in
 * memory, not in the writes, but a single unbounded `bulkWrite` has the same
 * shape of problem one layer down.
 */
export const PERP_WRITE_CHUNK = 5000;

/**
 * Idempotent upserts keyed on the model's unique index
 * `{ symbol, interval, series, timestamp }`.
 *
 * Returns `upsertedCount + modifiedCount` summed across chunks. Callers should
 * NOT treat a low number as failure: a re-run over bars that are already stored
 * reports 0 while nothing is wrong, which is why the route also reports how
 * many files it fetched.
 */
export async function bulkUpsertPerpCandles(
  ops: UpsertOp<PerpCandleFields>[]
): Promise<number> {
  let written = 0;
  for (let i = 0; i < ops.length; i += PERP_WRITE_CHUNK) {
    const chunk = ops.slice(i, i + PERP_WRITE_CHUNK);
    const result = await PerpCandle.bulkWrite(
      chunk.map((op) => ({
        updateOne: { filter: op.filter, update: { $set: op.set }, upsert: true },
      })),
      { ordered: false }
    );
    written += (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0);
  }
  return written;
}
