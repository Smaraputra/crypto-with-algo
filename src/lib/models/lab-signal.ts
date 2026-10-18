import mongoose, { Schema, type Document } from 'mongoose';

import type { LabCandidateId, LabTimeframeAny, LabVersion } from '@/lib/signals/lab/candidates';
import type { LabSkipReason as LabV1SkipReason } from '@/lib/signals/lab/factors';

export type LabSkipReason = LabV1SkipReason | 'va_incomplete';

export const LAB_SKIP_REASONS: readonly LabSkipReason[] = [
  'rv_skipped',
  'v8_missing',
  'bars_incomplete',
  'bars_not_contiguous',
  'forming_bar',
  'ratio_incomplete',
  'ratio_stale',
  'ratio_no_spread',
  'va_incomplete',
];

/**
 * One lab score of a hypothesis's cross-section at the bar close `barClose` (T).
 * Immutable once written (insertLabSignalOnce uses $setOnInsert). `late` is true when
 * it was written after T + D, and such a bar places no bet. `inputs` records what the
 * scores read, per candidate, so a skipped coin can be traced to its cause.
 */
export interface ILabSignal extends Document {
  version: LabVersion;
  hypothesis: string; // e.g. 'L2-15m'
  candidate: LabCandidateId;
  timeframe: LabTimeframeAny;
  barClose: number; // T, ms UTC
  writtenAt: Date;
  late: boolean;
  scores: Record<string, number>;
  skipped: { symbol: string; reason: LabSkipReason }[];
  inputs: Record<string, unknown>;
  createdAt: Date;
}

export type LabSignalFields = Omit<ILabSignal, keyof Document | 'createdAt'>;

const skippedSchema = new Schema(
  {
    symbol: { type: String, required: true },
    reason: {
      type: String,
      enum: LAB_SKIP_REASONS,
      required: true,
    },
  },
  { _id: false }
);

const labSignalSchema = new Schema<ILabSignal>(
  {
    version: { type: String, enum: ['lab-v1', 'lab-v2'], required: true },
    hypothesis: { type: String, required: true },
    candidate: { type: String, enum: ['L1', 'L2', 'L3', 'L4', 'N2', 'N3'], required: true },
    timeframe: { type: String, enum: ['5m', '15m', '1h', '4h', '8h', '1d', '1w'], required: true },
    barClose: { type: Number, required: true },
    writtenAt: { type: Date, required: true },
    late: { type: Boolean, required: true },
    scores: { type: Schema.Types.Mixed, required: true },
    skipped: { type: [skippedSchema], default: [] },
    inputs: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false }
);

labSignalSchema.index({ version: 1, hypothesis: 1, barClose: 1 }, { unique: true });

export const LabSignal =
  (mongoose.models.LabSignal as mongoose.Model<ILabSignal>) ||
  mongoose.model<ILabSignal>('LabSignal', labSignalSchema, 'labsignals');

/**
 * Inserts the row unless one exists for (version, hypothesis, barClose). Never overwrites.
 * The schema is checked first, because an upsert's $setOnInsert skips Mongoose validation.
 */
export async function insertLabSignalOnce(fields: LabSignalFields): Promise<{ inserted: boolean }> {
  await new LabSignal(fields).validate();
  try {
    const result = await LabSignal.updateOne(
      { version: fields.version, hypothesis: fields.hypothesis, barClose: fields.barClose },
      { $setOnInsert: fields },
      { upsert: true }
    );
    return { inserted: result.upsertedCount === 1 };
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000) {
      return { inserted: false };
    }
    throw error;
  }
}
