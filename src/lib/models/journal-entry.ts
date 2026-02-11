import mongoose, { Schema, type Document } from 'mongoose';

export const JOURNAL_ACTIONS = ['buy', 'sell', 'hold', 'skip'] as const;

export const MARKET_CONDITIONS = [
  'trending_up',
  'trending_down',
  'ranging',
  'volatile',
  'calm',
] as const;

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
  tags: string[];
  indicatorSnapshot: Record<string, unknown> | null;
  strategyId: string | null;
  backtestResultId: string | null;
  lessonsLearned: string;
  setupType: string;
  marketCondition: (typeof MARKET_CONDITIONS)[number] | null;
  sentiment: { fearGreedIndex: number; fearGreedLabel: string } | null;
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
    tags: { type: [String], default: [] },
    indicatorSnapshot: { type: Schema.Types.Mixed, default: null },
    strategyId: { type: String, default: null },
    backtestResultId: { type: String, default: null },
    lessonsLearned: { type: String, default: '' },
    setupType: { type: String, default: '' },
    marketCondition: {
      type: String,
      enum: [...MARKET_CONDITIONS, null],
      default: null,
    },
    sentiment: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

journalEntrySchema.index({ userId: 1, createdAt: -1 });
journalEntrySchema.index({ userId: 1, symbol: 1 });
journalEntrySchema.index({ userId: 1, tags: 1 });

export const MAX_JOURNAL_ENTRIES_PER_USER = 1000;

export const JournalEntry =
  mongoose.models.JournalEntry ||
  mongoose.model<IJournalEntry>('JournalEntry', journalEntrySchema);
