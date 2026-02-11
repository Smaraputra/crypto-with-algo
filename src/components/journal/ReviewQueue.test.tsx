import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useJournal', () => ({
  useJournalEntries: vi.fn(),
  useReviewJournalEntry: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
);

import { ReviewQueue } from './ReviewQueue';
import { useJournalEntries } from '@/hooks/useJournal';
import type { JournalEntry } from '@/types/journal';

const closedUnreviewed: JournalEntry = {
  _id: 'j-unreviewed',
  userId: 'user-1',
  symbol: 'BTCUSDT',
  interval: '1h',
  signalScore: 45,
  signalTier: 'buy',
  action: 'buy',
  entryPrice: 42000,
  exitPrice: 44000,
  outcomePnlPercent: 4.76,
  notes: '',
  reviewedAt: null,
  tags: [],
  indicatorSnapshot: null,
  strategyId: null,
  backtestResultId: null,
  lessonsLearned: '',
  setupType: '',
  marketCondition: null,
  sentiment: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

describe('ReviewQueue', () => {
  it('shows loading state', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useJournalEntries>);

    render(<ReviewQueue />);
    expect(screen.getByTestId('review-queue-loading')).toBeInTheDocument();
  });

  it('shows empty state when no unreviewed entries', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [], total: 0, page: 1, totalPages: 0 },
      isLoading: false,
    } as unknown as ReturnType<typeof useJournalEntries>);

    render(<ReviewQueue />);
    expect(screen.getByTestId('review-queue-empty')).toBeInTheDocument();
  });

  it('shows unreviewed closed trades', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [closedUnreviewed], total: 1, page: 1, totalPages: 1 },
      isLoading: false,
    } as unknown as ReturnType<typeof useJournalEntries>);

    render(<ReviewQueue />);
    expect(screen.getByTestId('review-queue')).toBeInTheDocument();
    expect(screen.getByText('1 trade awaiting review')).toBeInTheDocument();
  });

  it('filters out entries without exit price', () => {
    const openEntry: JournalEntry = {
      ...closedUnreviewed,
      _id: 'j-open',
      exitPrice: null,
      outcomePnlPercent: null,
    };

    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [closedUnreviewed, openEntry], total: 2, page: 1, totalPages: 1 },
      isLoading: false,
    } as unknown as ReturnType<typeof useJournalEntries>);

    render(<ReviewQueue />);
    expect(screen.getByText('1 trade awaiting review')).toBeInTheDocument();
  });
});
