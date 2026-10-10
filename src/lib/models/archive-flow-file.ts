import mongoose, { Schema, type Document } from 'mongoose';

/**
 * Resume ledger for `scripts/ops/ingest-agg-flow.ts`: one document per
 * (symbol, period) monthly aggTrades archive file. A row exists only once the
 * file's buckets were all written to `archiveflowbars` (`complete`) or the
 * archive answered 404 (`missing`), so a file with no row is retried on the
 * next run. Research only: nothing in the live path reads it.
 */
export interface IArchiveFlowFile extends Document {
  symbol: string;
  /** 'YYYY-MM'. */
  period: string;
  status: 'complete' | 'missing';
  /** CSV lines read, header included. */
  lines: number;
  /** Buckets written. */
  buckets: number;
  /** Rows older than their open bucket, left out of every bucket. Nonzero is a defect to look at. */
  outOfOrder: number;
  bytesUncompressed: number;
  /** Days in the period x 288. */
  expectedBuckets: number;
  /** UTC dates ('YYYY-MM-DD') of the period holding fewer than 288 buckets. */
  missingDays: string[];
  /** The zip's crc32 and size matched what was inflated (a mismatch fails the file instead). */
  crcOk: boolean;
  startedAt: Date;
  completedAt: Date;
}

const archiveFlowFileSchema = new Schema<IArchiveFlowFile>(
  {
    symbol: { type: String, required: true },
    period: { type: String, required: true },
    status: { type: String, required: true, enum: ['complete', 'missing'] },
    lines: { type: Number, required: true, default: 0 },
    buckets: { type: Number, required: true, default: 0 },
    outOfOrder: { type: Number, required: true, default: 0 },
    bytesUncompressed: { type: Number, required: true, default: 0 },
    expectedBuckets: { type: Number, required: true, default: 0 },
    missingDays: { type: [String], default: [] },
    crcOk: { type: Boolean, required: true },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, required: true },
  },
  { timestamps: false }
);

archiveFlowFileSchema.index({ symbol: 1, period: 1 }, { unique: true });

export const ArchiveFlowFile =
  mongoose.models.ArchiveFlowFile ||
  mongoose.model<IArchiveFlowFile>('ArchiveFlowFile', archiveFlowFileSchema, 'archiveflowfiles');
