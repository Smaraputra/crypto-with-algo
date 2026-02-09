import type { JournalEntry, CreateJournalEntryInput } from '@/types/journal';

export const mockJournalEntry: JournalEntry = {
  _id: 'journal-1',
  userId: 'user-1',
  symbol: 'BTCUSDT',
  interval: '1h',
  signalScore: 45,
  signalTier: 'buy',
  action: 'buy',
  entryPrice: 42000,
  exitPrice: null,
  outcomePnlPercent: null,
  notes: 'Strong momentum signal',
  reviewedAt: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

export const mockJournalEntry2: JournalEntry = {
  _id: 'journal-2',
  userId: 'user-1',
  symbol: 'ETHUSDT',
  interval: '4h',
  signalScore: -35,
  signalTier: 'sell',
  action: 'sell',
  entryPrice: 2200,
  exitPrice: 2100,
  outcomePnlPercent: 4.55,
  notes: 'Bearish crossover confirmed',
  reviewedAt: new Date('2025-01-02T12:00:00.000Z') as unknown as null,
  createdAt: '2025-01-02T00:00:00.000Z',
  updatedAt: '2025-01-02T12:00:00.000Z',
};

export const mockSkippedEntry: JournalEntry = {
  _id: 'journal-3',
  userId: 'user-1',
  symbol: 'SOLUSDT',
  interval: '15m',
  signalScore: 5,
  signalTier: 'neutral',
  action: 'skip',
  entryPrice: null,
  exitPrice: null,
  outcomePnlPercent: null,
  notes: 'Too weak to act on',
  reviewedAt: null,
  createdAt: '2025-01-03T00:00:00.000Z',
  updatedAt: '2025-01-03T00:00:00.000Z',
};

export const mockJournalEntries: JournalEntry[] = [
  mockJournalEntry,
  mockJournalEntry2,
  mockSkippedEntry,
];

export const mockCreateJournalInput: CreateJournalEntryInput = {
  symbol: 'BTCUSDT',
  interval: '1h',
  signalScore: 45,
  signalTier: 'buy',
  action: 'buy',
  entryPrice: 42000,
  notes: 'Strong momentum signal',
};
