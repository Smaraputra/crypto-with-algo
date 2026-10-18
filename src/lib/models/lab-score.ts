import mongoose, { Schema, type Document } from 'mongoose';

import type { LabVersion } from '@/lib/signals/lab/candidates';
import type { EProcessState } from '@/lib/signals/lab/e-process';

export type LabNoBetReason = 'late' | 'cross_section' | 'no_hurdle' | 'degenerate' | 'no_position';
export const LAB_NO_BET_REASONS: readonly LabNoBetReason[] = [
  'late',
  'cross_section',
  'no_hurdle',
  'degenerate',
  'no_position',
];

/**
 * The graded lab bar: the metric, the hurdle, the bet and the e-process state after it.
 * Immutable once written (insertLabScoreOnce). Graded strictly in barClose order per hypothesis,
 * each row's `state` is the next bar's starting state.
 */
export interface ILabScore extends Document {
  version: LabVersion;
  hypothesis: string;
  barClose: number;
  gradedAt: Date;
  /** Coins with a score and both prices. */
  n: number;
  x: number | null;
  b: number | null;
  turnover: number | null;
  kN: number | null;
  /** Cross-sectional population SD of the priced coins' returns, null when n < 8. */
  s: number | null;
  sHat: number | null;
  lambda: number;
  lambda0: number;
  bet: boolean;
  noBetReason: LabNoBetReason | null;
  /** Book weights at T from every scored coin, the w_prev of the next bar. Null when n < 8. */
  weights: Record<string, number> | null;
  /** Realised net return of the rank-weighted book on the priced coins, after turnover cost. Descriptive. */
  netBookReturn: number | null;
  /** Open of the perp 5m kline at T + D (start) and at T + D + Δ (end), per priced coin. */
  prices: Record<string, { start: number; end: number }>;
  funding?: Record<string, number> | null;
  state: EProcessState;
  createdAt: Date;
}

export type LabScoreFields = Omit<ILabScore, keyof Document | 'createdAt'>;

const stateSchema = new Schema(
  {
    logE: { type: Number, required: true },
    logE0: { type: Number, required: true },
    n: { type: Number, required: true },
    sumD: { type: Number, required: true },
    sumD2: { type: Number, required: true },
    sumX: { type: Number, required: true },
    sumX2: { type: Number, required: true },
    crossedAt: { type: Number, default: null },
    absorbed: { type: Boolean },
  },
  { _id: false }
);

const labScoreSchema = new Schema<ILabScore>(
  {
    version: { type: String, enum: ['lab-v1', 'lab-v2'], required: true },
    hypothesis: { type: String, required: true },
    barClose: { type: Number, required: true },
    gradedAt: { type: Date, required: true },
    n: { type: Number, required: true },
    x: { type: Number, default: null },
    b: { type: Number, default: null },
    turnover: { type: Number, default: null },
    kN: { type: Number, default: null },
    s: { type: Number, default: null },
    sHat: { type: Number, default: null },
    lambda: { type: Number, required: true },
    lambda0: { type: Number, required: true },
    bet: { type: Boolean, required: true },
    noBetReason: { type: String, enum: [...LAB_NO_BET_REASONS, null], default: null },
    weights: { type: Schema.Types.Mixed, default: null },
    netBookReturn: { type: Number, default: null },
    prices: { type: Schema.Types.Mixed, required: true },
    funding: { type: Schema.Types.Mixed, default: null },
    state: { type: stateSchema, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false }
);

labScoreSchema.index({ version: 1, hypothesis: 1, barClose: 1 }, { unique: true });

export const LabScore =
  (mongoose.models.LabScore as mongoose.Model<ILabScore>) ||
  mongoose.model<ILabScore>('LabScore', labScoreSchema, 'labscores');

/**
 * Inserts the row unless one exists for (version, hypothesis, barClose). Never overwrites.
 * The schema is checked first, because an upsert's $setOnInsert skips Mongoose validation.
 */
export async function insertLabScoreOnce(fields: LabScoreFields): Promise<{ inserted: boolean }> {
  await new LabScore(fields).validate();
  try {
    const result = await LabScore.updateOne(
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
