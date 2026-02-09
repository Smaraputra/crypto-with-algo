import mongoose, { Schema, type Document } from 'mongoose';

export const JOURNAL_ACTIONS = ['buy', 'sell', 'hold', 'skip'] as const;

export interface IJournalEntry extends Document {
  userId: string;
  symbol: string;
  interval: string;
  signalScore: number;
  signalTier: string;
  action: (typeof JOURNAL_ACTIONS)[number];
  entryPrice: number | null;
  exitPrice: number | null;
  outcomePnlPercent: number | null;
  notes: string;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const journalEntrySchema = new Schema<IJournalEntry>(
  {
    userId: { type: String, required: true },
    symbol: { type: String, required: true },
    interval: { type: String, required: true },
    signalScore: { type: Number, required: true },
    signalTier: { type: String, required: true },
    action: {
      type: String,
      enum: JOURNAL_ACTIONS,
      required: true,
    },
    entryPrice: { type: Number, default: null },
    exitPrice: { type: Number, default: null },
    outcomePnlPercent: { type: Number, default: null },
    notes: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

journalEntrySchema.index({ userId: 1, createdAt: -1 });
journalEntrySchema.index({ userId: 1, symbol: 1 });

export const MAX_JOURNAL_ENTRIES_PER_USER = 500;

export const JournalEntry =
  mongoose.models.JournalEntry ||
  mongoose.model<IJournalEntry>('JournalEntry', journalEntrySchema);
