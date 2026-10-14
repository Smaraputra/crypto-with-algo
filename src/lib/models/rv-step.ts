import mongoose, { Schema, type Document } from 'mongoose';

import type { RvStepRecord } from '@/lib/signals/cross-sectional/engine';
import type { RvBookState } from './rv-book';

/**
 * One rebalance of an rv book: the signal at `barTime` traded at `fillTime`
 * (its bar close) on both cost tracks.
 *
 * Upserted on (bookName, barTime), so a replay after a crash or a cursor
 * rollback rewrites the same document rather than adding one (D09). A step
 * the desk could not take yet is stored with `pendingReasons` and null
 * records, and is overwritten in place once it completes.
 *
 * `bookAfter` is the book state after this step. The next run restores from
 * it, which is what makes a replay of later steps byte-identical.
 */
export interface IRvStep extends Document {
  bookName: string;
  barTime: number;
  fillTime: number;
  /** Target weights from the ranking and the legs held, null when they could not be computed. */
  targets: Record<string, number> | null;
  taker: RvStepRecord | null;
  maker: RvStepRecord | null;
  bookAfter: RvBookState | null;
  /** UTC hour of fillTime: 0, 8 or 16. */
  rebalanceHourUtc: number;
  /** fillTime falls on a UTC Saturday or Sunday. */
  isWeekend: boolean;
  /** Empty for a completed step. */
  pendingReasons: string[];
  createdAt: Date;
}

const rvStepSchema = new Schema<IRvStep>(
  {
    bookName: { type: String, required: true },
    barTime: { type: Number, required: true },
    fillTime: { type: Number, required: true },
    targets: { type: Schema.Types.Mixed, default: null },
    taker: { type: Schema.Types.Mixed, default: null },
    maker: { type: Schema.Types.Mixed, default: null },
    bookAfter: { type: Schema.Types.Mixed, default: null },
    rebalanceHourUtc: { type: Number, required: true },
    isWeekend: { type: Boolean, required: true },
    pendingReasons: { type: [String], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false }
);

// The upsert key and the only index.
rvStepSchema.index({ bookName: 1, barTime: 1 }, { unique: true });

export const RvStep =
  (mongoose.models.RvStep as mongoose.Model<IRvStep>) ||
  mongoose.model<IRvStep>('RvStep', rvStepSchema, 'rvsteps');
