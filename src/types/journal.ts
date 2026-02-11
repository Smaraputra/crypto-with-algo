import { z } from 'zod';
import { SIGNAL_TIERS, type SignalTier } from '@/types/signal';
import type { IndicatorSnapshot } from '@/types/indicator-snapshot';

export const JOURNAL_ACTIONS = ['buy', 'sell', 'hold', 'skip'] as const;
export type JournalAction = (typeof JOURNAL_ACTIONS)[number];

export const MARKET_CONDITIONS = [
  'trending_up',
  'trending_down',
  'ranging',
  'volatile',
  'calm',
] as const;
export type MarketCondition = (typeof MARKET_CONDITIONS)[number];

export const createJournalEntrySchema = z.object({
  symbol: z.string().min(1, 'Symbol is required'),
  interval: z.string().min(1, 'Interval is required'),
  signalScore: z.number().min(-100).max(100),
  signalTier: z.enum(SIGNAL_TIERS),
  action: z.enum(JOURNAL_ACTIONS),
  entryPrice: z.number().positive().optional(),
  notes: z.string().max(10000).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  indicatorSnapshot: z.record(z.string(), z.unknown()).optional(),
  strategyId: z.string().optional(),
  backtestResultId: z.string().optional(),
  setupType: z.string().max(100).optional(),
  marketCondition: z.enum(MARKET_CONDITIONS).optional(),
  sentiment: z
    .object({
      fearGreedIndex: z.number().min(0).max(100),
      fearGreedLabel: z.string(),
    })
    .optional(),
});

export const updateJournalEntrySchema = z.object({
  exitPrice: z.number().positive().optional(),
  outcomePnlPercent: z.number().optional(),
  notes: z.string().max(10000).optional(),
  reviewedAt: z.coerce.date().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  lessonsLearned: z.string().max(10000).optional(),
  setupType: z.string().max(100).optional(),
  marketCondition: z.enum(MARKET_CONDITIONS).optional(),
  sentiment: z
    .object({
      fearGreedIndex: z.number().min(0).max(100),
      fearGreedLabel: z.string(),
    })
    .optional(),
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
  tags: string[];
  indicatorSnapshot: IndicatorSnapshot | null;
  strategyId: string | null;
  backtestResultId: string | null;
  lessonsLearned: string;
  setupType: string;
  marketCondition: MarketCondition | null;
  sentiment: { fearGreedIndex: number; fearGreedLabel: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface JournalEntryListResponse {
  entries: JournalEntry[];
  total?: number;
  page?: number;
  totalPages?: number;
}

export interface JournalEntryResponse {
  entry: JournalEntry;
}
