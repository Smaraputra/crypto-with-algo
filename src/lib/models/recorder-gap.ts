import mongoose, { Schema, type Document } from 'mongoose';

/**
 * A span in which `scripts/ops/market-recorder.ts` had no open stream
 * connection, so neither liquidations nor trade flow were recorded.
 *
 * Written when the span closes (`end` set), except at a graceful shutdown,
 * which writes `end: null`: the span is still open, and the next process sets
 * `end` when its first connection opens. An open row therefore means "not
 * recording since `start`".
 *
 * A crash leaves no shutdown row. The next process then writes a
 * `process-start` row starting at the previous process's last healthy
 * heartbeat, so the span is over-stated rather than missed.
 *
 * Swapping connections (the planned reconnect before Binance's 24-hour limit,
 * or a new top-N set) overlaps the old and new connection and writes no gap.
 *
 * Times are epoch ms, the recorder's clock. A study joins these against
 * `tradeflowbars.bucketStart` and `liquidationevents.tradeTime` directly.
 * A handful of rows a day at most. No TTL.
 */
export interface IRecorderGap extends Document {
  start: number;
  /** Null while the span is still open. */
  end: number | null;
  /** Why the connection was lost: a close code, `stale`, `connect-timeout`, `shutdown (SIGTERM)`, `process-start`. */
  reason: string;
  createdAt: Date;
  updatedAt: Date;
}

const recorderGapSchema = new Schema<IRecorderGap>(
  {
    start: { type: Number, required: true },
    end: { type: Number, default: null },
    reason: { type: String, required: true },
  },
  { timestamps: true }
);

recorderGapSchema.index({ start: 1 });
// The next process closes open rows with `{ end: null }`.
recorderGapSchema.index({ end: 1 });

export const RecorderGap =
  mongoose.models.RecorderGap ||
  mongoose.model<IRecorderGap>('RecorderGap', recorderGapSchema, 'recordergaps');
