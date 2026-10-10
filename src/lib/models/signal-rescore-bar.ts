import mongoose, { Schema, type Document } from 'mongoose';

/**
 * Re-scored signal bars of one historical re-score run, bucketed: one document
 * per symbol, cell and UTC day (UTC month for 1d), holding parallel arrays in
 * time order. Loaded by `scripts/ops/load-rescore.ts` from the hashed rows file
 * of `scripts/research/v8-rescore.ts`; nothing else writes it.
 *
 * HINDSIGHT ROWS, NOT THE LIVE RECORD. These scores were computed after the
 * fact by running the scorer over stored data. The scheduler never published
 * them, so they must never reach GlobalSignal, SignalOutcome, the calibration
 * dashboard or the paper desk; an ESLint rule keeps the write path from
 * importing this model. The chart and the track-record panel read it, labelled.
 *
 * No TTL: the run is a fixed record, replaced only by loading a new run id.
 */
export interface ISignalRescoreBar extends Document {
  runId: string;
  symbol: string;
  interval: string;
  tradingStyle: string;
  /** UTC day start (UTC month start at 1d) of every bar in the document, epoch ms. */
  bucketStart: number;
  /** Candle open times, epoch ms, ascending. */
  t: number[];
  score: number[];
  /** Tier codes, -2 strong sell to 2 strong buy (see track-record/measures.ts tierCode). */
  tier: number[];
  /** Close-to-close forward return over the cell's horizon, percent. */
  fwd: number[];
}

const signalRescoreBarSchema = new Schema<ISignalRescoreBar>(
  {
    runId: { type: String, required: true },
    symbol: { type: String, required: true },
    interval: { type: String, required: true },
    tradingStyle: { type: String, required: true },
    bucketStart: { type: Number, required: true },
    t: { type: [Number], required: true },
    score: { type: [Number], required: true },
    tier: { type: [Number], required: true },
    fwd: { type: [Number], required: true },
  },
  { timestamps: false }
);

// The load key and the chart's range read.
signalRescoreBarSchema.index(
  { runId: 1, symbol: 1, interval: 1, tradingStyle: 1, bucketStart: 1 },
  { unique: true }
);

export const SignalRescoreBar =
  mongoose.models.SignalRescoreBar ||
  mongoose.model<ISignalRescoreBar>('SignalRescoreBar', signalRescoreBarSchema, 'signalrescorebars');
