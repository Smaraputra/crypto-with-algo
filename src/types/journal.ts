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

export const TRADE_EMOTIONS = [
  'calm',
  'confident',
  'anxious',
  'fomo',
  'revenge',
  'tired',
] as const;
export type TradeEmotion = (typeof TRADE_EMOTIONS)[number];

export const TRADE_EMOTION_LABELS: Record<TradeEmotion, string> = {
  calm: 'Calm',
  confident: 'Confident',
  anxious: 'Anxious',
  fomo: 'FOMO',
  revenge: 'Revenge',
  tired: 'Tired',
};

export const TRADE_MISTAKES = [
  'chased_entry',
  'oversized',
  'no_stop',
  'moved_stop',
  'exited_early',
  'held_too_long',
  'ignored_plan',
] as const;
export type TradeMistake = (typeof TRADE_MISTAKES)[number];

export const TRADE_MISTAKE_LABELS: Record<TradeMistake, string> = {
  chased_entry: 'Chased entry',
  oversized: 'Oversized position',
  no_stop: 'No stop loss',
  moved_stop: 'Moved stop loss',
  exited_early: 'Exited early',
  held_too_long: 'Held too long',
  ignored_plan: 'Ignored plan',
};

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
  emotion: z.enum(TRADE_EMOTIONS).optional(),
  mistakes: z.array(z.enum(TRADE_MISTAKES)).max(TRADE_MISTAKES.length).optional(),
  convictionLevel: z.number().int().min(1).max(5).optional(),
  plannedRiskReward: z.number().positive().max(100).optional(),
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
  emotion: z.enum(TRADE_EMOTIONS).optional(),
  mistakes: z.array(z.enum(TRADE_MISTAKES)).max(TRADE_MISTAKES.length).optional(),
  convictionLevel: z.number().int().min(1).max(5).optional(),
  plannedRiskReward: z.number().positive().max(100).optional(),
  sentiment: z
    .object({
      fearGreedIndex: z.number().min(0).max(100),
      fearGreedLabel: z.string(),
    })
    .optional(),
});

export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;
export type UpdateJournalEntryInput = z.infer<typeof updateJournalEntrySchema>;

export interface ReviewHistoryEntry {
  lessonsLearned: string;
  reviewedAt: string;
}

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
  reviewHistory: ReviewHistoryEntry[];
  setupType: string;
  marketCondition: MarketCondition | null;
  emotion: TradeEmotion | null;
  mistakes: TradeMistake[];
  convictionLevel: number | null;
  plannedRiskReward: number | null;
  sentiment: { fearGreedIndex: number; fearGreedLabel: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface JournalEntryListResponse {
  entries: JournalEntry[];
  total?: number;
  page?: number;
  totalPages?: number;
  entryLimit?: number;
  totalUserEntries?: number;
}

export interface JournalEntryResponse {
  entry: JournalEntry;
}
