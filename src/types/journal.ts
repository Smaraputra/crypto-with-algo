import { z } from 'zod';
import { SIGNAL_TIERS, type SignalTier } from '@/types/signal';

export const JOURNAL_ACTIONS = ['buy', 'sell', 'hold', 'skip'] as const;
export type JournalAction = (typeof JOURNAL_ACTIONS)[number];

export const createJournalEntrySchema = z.object({
  symbol: z.string().min(1, 'Symbol is required'),
  interval: z.string().min(1, 'Interval is required'),
  signalScore: z.number().min(-100).max(100),
  signalTier: z.enum(SIGNAL_TIERS),
  action: z.enum(JOURNAL_ACTIONS),
  entryPrice: z.number().positive().optional(),
  notes: z.string().max(1000).optional(),
});

export const updateJournalEntrySchema = z.object({
  exitPrice: z.number().positive().optional(),
  outcomePnlPercent: z.number().optional(),
  notes: z.string().max(1000).optional(),
  reviewedAt: z.coerce.date().optional(),
});

export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;
export type UpdateJournalEntryInput = z.infer<typeof updateJournalEntrySchema>;

export interface JournalEntry {
  _id: string;
  userId: string;
  symbol: string;
  interval: string;
  signalScore: number;
  signalTier: SignalTier;
  action: JournalAction;
  entryPrice: number | null;
  exitPrice: number | null;
  outcomePnlPercent: number | null;
  notes: string;
  reviewedAt: Date | null;
  createdAt: string;
  updatedAt: string;
}

export interface JournalEntryListResponse {
  entries: JournalEntry[];
}

export interface JournalEntryResponse {
  entry: JournalEntry;
}
