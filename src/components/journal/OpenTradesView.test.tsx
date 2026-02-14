import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useJournal', () => ({
  useJournalEntries: vi.fn(),
  useUpdateJournalEntry: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useDeleteJournalEntry: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
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

import { OpenTradesView } from './OpenTradesView';
import { useJournalEntries } from '@/hooks/useJournal';

const openEntry = {
  _id: 'open-1',
  userId: 'user-1',
  symbol: 'BTCUSDT',
  interval: '1h',
  signalScore: 75,
  signalTier: 'strong_buy',
  action: 'buy',
  entryPrice: 50000,
  exitPrice: null,
  outcomePnlPercent: null,
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

describe('OpenTradesView', () => {
  it('shows loading state', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as never);

    render(<OpenTradesView />);
    expect(screen.getByTestId('open-trades-loading')).toBeInTheDocument();
  });

  it('shows empty state when no open trades', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [] },
      isLoading: false,
    } as never);

    render(<OpenTradesView />);
    expect(screen.getByTestId('open-trades-empty')).toBeInTheDocument();
    expect(screen.getByText('No open trades.')).toBeInTheDocument();
  });

  it('renders open trades with close button', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [openEntry] },
      isLoading: false,
    } as never);

    render(<OpenTradesView />);
    expect(screen.getByTestId('open-trades-list')).toBeInTheDocument();
    expect(screen.getByText('1 open trade')).toBeInTheDocument();
    expect(screen.getByText('Close Trade')).toBeInTheDocument();
  });

  it('passes status=open to useJournalEntries', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [] },
      isLoading: false,
    } as never);

    render(<OpenTradesView />);
    expect(useJournalEntries).toHaveBeenCalledWith({ status: 'open', limit: 50 });
  });

  it('shows correct count for multiple trades', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [openEntry, { ...openEntry, _id: 'open-2' }] },
      isLoading: false,
    } as never);

    render(<OpenTradesView />);
    expect(screen.getByText('2 open trades')).toBeInTheDocument();
  });
});
