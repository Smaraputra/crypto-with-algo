import type { UpsertOp } from '@/lib/archive-ingestion';
import type { OptionsFlowUpsertFields } from '@/lib/options-flow';
import { OptionsFlowHour } from '@/lib/models/options-flow-hour';

/**
 * Writing OptionsFlowHour documents, shared by the dvol and trades jobs of
 * `scripts/ops/ingest-deribit.ts`.
 *
 * It lives here rather than inside the CLI for the reason
 * `bulkUpsertPerpCandles` in `perp-candles.ts` does: two writers that shape
 * the same upsert by hand are two writers that can drift.
 */

/** Documents per `bulkWrite` unless the caller asks for a different size. */
export const OPTIONS_FLOW_WRITE_CHUNK = 5000;

/**
 * Idempotent upserts keyed on the model's unique index
 * `{ currency, timestamp }`.
 *
 * Returns `upsertedCount + modifiedCount` summed across chunks. Callers should
 * NOT treat a low number as failure: a re-run over hours that are already
 * stored reports 0 while nothing is wrong.
 */
export async function bulkUpsertOptionsFlow(
  ops: UpsertOp<OptionsFlowUpsertFields>[],
  chunk: number = OPTIONS_FLOW_WRITE_CHUNK
): Promise<number> {
  let written = 0;
  for (let i = 0; i < ops.length; i += chunk) {
    const slice = ops.slice(i, i + chunk);
    const result = await OptionsFlowHour.bulkWrite(
      slice.map((op) => ({
        updateOne: { filter: op.filter, update: { $set: op.set }, upsert: true },
      })),
      { ordered: false }
    );
    written += (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0);
  }
  return written;
}
