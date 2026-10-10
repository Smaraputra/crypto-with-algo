import mongoose, { Schema, type Document } from 'mongoose';

import type { CellTrack } from '@/lib/signals/track-record/types';

/**
 * Provenance and precomputed statistics of one historical re-score run: the
 * hashes and commit it was loaded from, the pooled per-cell verdicts copied
 * from the re-score report, and per-symbol and per-month measures computed by
 * the loader. Written only by `scripts/ops/load-rescore.ts`; read by the
 * track-record route. The route validates `cells` with a Zod schema, so the
 * Mixed type here never reaches the client unchecked.
 *
 * Research only, like SignalRescoreBar: never the live record.
 */
export interface ISignalRescoreRun extends Document {
  runId: string;
  configVersion: number;
  windowStart: string;
  windowEnd: string;
  cutoffs: { buy: number; strong: number };
  rowsSha256: string;
  reportSha256: string;
  gitCommit: string;
  resamples: number;
  seed: number;
  loadedAt: Date;
  cells: CellTrack[];
}

const signalRescoreRunSchema = new Schema<ISignalRescoreRun>(
  {
    runId: { type: String, required: true, unique: true },
    configVersion: { type: Number, required: true },
    windowStart: { type: String, required: true },
    windowEnd: { type: String, required: true },
    cutoffs: {
      buy: { type: Number, required: true },
      strong: { type: Number, required: true },
    },
    rowsSha256: { type: String, required: true },
    reportSha256: { type: String, required: true },
    gitCommit: { type: String, required: true },
    resamples: { type: Number, required: true },
    seed: { type: Number, required: true },
    loadedAt: { type: Date, required: true },
    cells: { type: Schema.Types.Mixed, default: [] },
  },
  { timestamps: false }
);

export const SignalRescoreRun =
  mongoose.models.SignalRescoreRun ||
  mongoose.model<ISignalRescoreRun>('SignalRescoreRun', signalRescoreRunSchema, 'signalrescoreruns');
