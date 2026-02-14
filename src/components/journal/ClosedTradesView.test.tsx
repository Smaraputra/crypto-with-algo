import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useJournal', () => ({
  useJournalEntries: vi.fn(),
  useReviewJournalEntry: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useUpdateJournalEntry: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useDeleteJournalEntry: vi.fn(() => ({
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

import { ClosedTradesView } from './ClosedTradesView';
import { useJournalEntries } from '@/hooks/useJournal';

const closedEntry = {
  _id: 'closed-1',
  userId: 'user-1',
  symbol: 'BTCUSDT',
  interval: '1h',
  signalScore: 75,
  signalTier: 'strong_buy',
  action: 'buy',
  entryPrice: 50000,
  exitPrice: 55000,
  outcomePnlPercent: 10,
  notes: '',
  reviewedAt: null,
  tags: [],
  indicatorSnapshot: null,
  strategyId: null,
  backtestResultId: null,
  lessonsLearned: '',
  reviewHistory: [],
  setupType: '',
  marketCondition: null,
  sentiment: null,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};

const reviewedEntry = {
  ...closedEntry,
  _id: 'closed-2',
  reviewedAt: '2025-01-02T00:00:00Z',
  lessonsLearned: 'Good trade',
};

describe('ClosedTradesView', () => {
  it('shows loading state', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as never);

    render(<ClosedTradesView />);
    expect(screen.getByTestId('closed-trades-loading')).toBeInTheDocument();
  });

  it('shows empty state when no closed trades', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [] },
      isLoading: false,
    } as never);

    render(<ClosedTradesView />);
    expect(screen.getByTestId('closed-trades-empty')).toBeInTheDocument();
    expect(screen.getByText('No closed trades.')).toBeInTheDocument();
  });

  it('renders closed trades list', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [closedEntry] },
      isLoading: false,
    } as never);

    render(<ClosedTradesView />);
    expect(screen.getByTestId('closed-trades-list')).toBeInTheDocument();
    expect(screen.getByText('1 closed trade')).toBeInTheDocument();
  });

  it('shows Review button for unreviewed trades', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [closedEntry] },
      isLoading: false,
    } as never);

    render(<ClosedTradesView />);
    expect(screen.getByText('Review')).toBeInTheDocument();
  });

  it('does not show Review button for reviewed trades', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [reviewedEntry] },
      isLoading: false,
    } as never);

    render(<ClosedTradesView />);
    expect(screen.queryByText('Review')).not.toBeInTheDocument();
  });

  it('shows unreviewed count badge', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [closedEntry, reviewedEntry] },
      isLoading: false,
    } as never);

    render(<ClosedTradesView />);
    expect(screen.getByText('1 unreviewed')).toBeInTheDocument();
  });

  it('passes status=closed to useJournalEntries', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [] },
      isLoading: false,
    } as never);

    render(<ClosedTradesView />);
    expect(useJournalEntries).toHaveBeenCalledWith({ status: 'closed', limit: 50 });
  });

  it('shows correct count for multiple trades', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [closedEntry, reviewedEntry] },
      isLoading: false,
    } as never);

    render(<ClosedTradesView />);
    expect(screen.getByText('2 closed trades')).toBeInTheDocument();
  });
});
