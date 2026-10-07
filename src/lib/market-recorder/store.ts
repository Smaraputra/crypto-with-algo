import { recordJobRun } from '@/lib/job-run';
import { JobHeartbeat } from '@/lib/models/job-heartbeat';
import { LiquidationEvent } from '@/lib/models/liquidation-event';
import { RecorderGap } from '@/lib/models/recorder-gap';
import { RecorderSymbolSet } from '@/lib/models/recorder-symbol-set';
import { TradeFlowBar } from '@/lib/models/trade-flow-bar';

import type { LiquidationRecord } from './messages';
import type { RecorderStore } from './recorder';
import { SUMMED_BAR_FIELDS, type TradeFlowBarRecord } from './trade-flow';

/**
 * The market recorder's Mongo write path. The caller connects first
 * (`connectDB`); the heartbeat goes through `recordJobRun`, which never throws.
 *
 * TRADE-FLOW MERGE RULE. A bucket can be written in more than one part: a
 * trade that lands after its bar was flushed, or the two halves of a bucket
 * either side of a process restart. Each part covers a contiguous range of
 * aggregate trade ids, so the upsert compares ranges:
 *
 *   - disjoint from the stored range: the parts are added together (sums
 *     added, high and low widened, first and last price taken from the lower
 *     and higher ids, `complete` only if both parts were, `segments` + 1);
 *   - overlapping: the incoming part replaces the stored one. That is a retry
 *     of a write whose acknowledgement was lost, and replacing keeps it
 *     idempotent where adding would double count.
 *
 * The rule is a single pipeline update, so it is atomic per document.
 */

export const RECORDER_JOB = 'market-recorder';

/** Rows per bulkWrite. */
export const RECORDER_WRITE_CHUNK = 500;

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** The pipeline that merges or replaces one bar; see the header. Exported for tests. */
export function tradeFlowMergePipeline(bar: TradeFlowBarRecord): Record<string, unknown>[] {
  const merge = '$__merge';
  const summed = Object.fromEntries(
    SUMMED_BAR_FIELDS.map((f) => [f, { $cond: [merge, { $add: [`$${f}`, bar[f]] }, bar[f]] }])
  );
  return [
    {
      $set: {
        __merge: {
          $and: [
            { $ne: [{ $type: '$lastAggId' }, 'missing'] },
            { $or: [{ $gt: [bar.firstAggId, '$lastAggId'] }, { $lt: [bar.lastAggId, '$firstAggId'] }] },
          ],
        },
      },
    },
    {
      // Every expression in one $set reads the stored values, not the ones
      // this stage writes, so firstPrice below compares against the old id.
      $set: {
        symbol: { $literal: bar.symbol },
        bucketStart: bar.bucketStart,
        ...summed,
        highPrice: { $cond: [merge, { $max: ['$highPrice', bar.highPrice] }, bar.highPrice] },
        lowPrice: { $cond: [merge, { $min: ['$lowPrice', bar.lowPrice] }, bar.lowPrice] },
        firstPrice: {
          $cond: [{ $and: [merge, { $lt: ['$firstAggId', bar.firstAggId] }] }, '$firstPrice', bar.firstPrice],
        },
        lastPrice: {
          $cond: [{ $and: [merge, { $gt: ['$lastAggId', bar.lastAggId] }] }, '$lastPrice', bar.lastPrice],
        },
        firstAggId: { $cond: [merge, { $min: ['$firstAggId', bar.firstAggId] }, bar.firstAggId] },
        lastAggId: { $cond: [merge, { $max: ['$lastAggId', bar.lastAggId] }, bar.lastAggId] },
        complete: { $cond: [merge, { $and: ['$complete', bar.complete] }, bar.complete] },
        segments: { $cond: [merge, { $add: [{ $ifNull: ['$segments', 1] }, 1] }, 1] },
      },
    },
    { $unset: '__merge' },
  ];
}

export function createMongoRecorderStore(chunk: number = RECORDER_WRITE_CHUNK): RecorderStore {
  return {
    async writeLiquidations(events: readonly LiquidationRecord[]): Promise<number> {
      let stored = 0;
      for (const part of chunks(events, chunk)) {
        // Upsert-if-absent on the unique key, so a duplicate is a no-op rather
        // than an E11000 that would fail the batch.
        const result = await LiquidationEvent.bulkWrite(
          part.map((e) => ({
            updateOne: {
              filter: {
                symbol: e.symbol,
                tradeTime: e.tradeTime,
                side: e.side,
                filledAccumulatedQty: e.filledAccumulatedQty,
              },
              update: { $setOnInsert: e },
              upsert: true,
            },
          })),
          { ordered: false }
        );
        stored += result.upsertedCount ?? 0;
      }
      return stored;
    },

    async writeTradeFlowBars(bars: readonly TradeFlowBarRecord[]): Promise<number> {
      let touched = 0;
      for (const part of chunks(bars, chunk)) {
        // The native collection, because mongoose 9 refuses pipeline updates
        // by default; the values are already typed by TradeFlowBarRecord.
        const result = await TradeFlowBar.collection.bulkWrite(
          part.map((bar) => ({
            updateOne: {
              filter: { symbol: bar.symbol, bucketStart: bar.bucketStart },
              update: tradeFlowMergePipeline(bar),
              upsert: true,
            },
          })),
          { ordered: false }
        );
        touched += (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0);
      }
      return touched;
    },

    async writeGap(gap): Promise<void> {
      await RecorderGap.create(gap);
    },

    async closeOpenGaps(end: number): Promise<number> {
      const result = await RecorderGap.updateMany({ end: null }, { $set: { end } });
      return result.modifiedCount ?? 0;
    },

    async lastHealthyAt(): Promise<number | null> {
      const row = (await JobHeartbeat.findOne({ job: RECORDER_JOB }).select('lastSuccessAt').lean()) as {
        lastSuccessAt?: Date | null;
      } | null;
      return row?.lastSuccessAt ? new Date(row.lastSuccessAt).getTime() : null;
    },

    async writeSymbolSet(set): Promise<void> {
      await RecorderSymbolSet.create(set);
    },

    async heartbeat(outcome): Promise<void> {
      await recordJobRun(RECORDER_JOB, outcome);
    },
  };
}

/** Builds the four collections' indexes before the first write, so the dedupe keys hold from row one. */
export async function ensureRecorderIndexes(): Promise<void> {
  await Promise.all([
    LiquidationEvent.createIndexes(),
    TradeFlowBar.createIndexes(),
    RecorderGap.createIndexes(),
    RecorderSymbolSet.createIndexes(),
  ]);
}
