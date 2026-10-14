import mongoose, { Schema, type Document } from 'mongoose';

import type { RvFactorRow, RvRanked, RvSkipReason } from '@/lib/signals/cross-sectional/engine';

/** The settlement the carry factor read for one symbol. */
export interface RvSignalSettlementInput {
  fundingTime: number;
  rate: number;
}

/**
 * One rv-v1 score of the 8h cross-section, for the bar that OPENED at
 * `barTime` and closed at `barCloseTime`.
 *
 * Immutable once written: the signal job inserts it with `$setOnInsert` only,
 * so a re-run or a retry for the same bar can never rewrite a signal the desk
 * may already have stepped (D10). The desk derives targets from `ranked` and
 * the betas in `rows`, so nothing here depends on the book's state.
 *
 * `inputs` records what the score read: the newest closed bar per symbol
 * (null when its fetch failed) and the settlement used for carry (null when
 * none was stored), so a skipped symbol can be traced to its cause.
 */
export interface IRvSignal extends Document {
  version: 'rv-v1';
  barTime: number;
  barCloseTime: number;
  rows: RvFactorRow[];
  ranked: RvRanked[];
  skipped: { symbol: string; reason: RvSkipReason }[];
  inputs: {
    lastBarOpenTime: Record<string, number | null>;
    settlement: Record<string, RvSignalSettlementInput | null>;
  };
  createdAt: Date;
}

const rowSchema = new Schema(
  {
    symbol: { type: String, required: true },
    mom: { type: Number, required: true },
    idio: { type: Number, required: true },
    carry: { type: Number, required: true },
    flow: { type: Number, required: true },
    beta: { type: Number, required: true },
    zMom: { type: Number, required: true },
    zIdio: { type: Number, required: true },
    zCarry: { type: Number, required: true },
    zFlow: { type: Number, required: true },
  },
  { _id: false }
);

const rankedSchema = new Schema(
  {
    symbol: { type: String, required: true },
    compositeZ: { type: Number, required: true },
    rank: { type: Number, required: true },
  },
  { _id: false }
);

const skippedSchema = new Schema(
  {
    symbol: { type: String, required: true },
    reason: {
      type: String,
      enum: ['bars_incomplete', 'bars_not_contiguous', 'carry_missing', 'carry_stale', 'flow_missing'],
      required: true,
    },
  },
  { _id: false }
);

const rvSignalSchema = new Schema<IRvSignal>(
  {
    version: { type: String, enum: ['rv-v1'], required: true },
    barTime: { type: Number, required: true },
    barCloseTime: { type: Number, required: true },
    rows: { type: [rowSchema], default: [] },
    ranked: { type: [rankedSchema], default: [] },
    skipped: { type: [skippedSchema], default: [] },
    inputs: {
      lastBarOpenTime: { type: Schema.Types.Mixed, required: true },
      settlement: { type: Schema.Types.Mixed, required: true },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false }
);

// The one key: a bar is scored once per rule version.
rvSignalSchema.index({ version: 1, barTime: 1 }, { unique: true });

export const RvSignal =
  (mongoose.models.RvSignal as mongoose.Model<IRvSignal>) ||
  mongoose.model<IRvSignal>('RvSignal', rvSignalSchema, 'rvsignals');
