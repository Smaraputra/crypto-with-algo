import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useJournal', () => ({
  useJournalEntries: vi.fn(() => ({ data: undefined, isLoading: false })),
  useDeleteJournalEntry: vi.fn(() => ({ mutate: vi.fn() })),
}));

import { JournalList } from './JournalList';

describe('JournalList', () => {
  it('shows empty state when no entries', () => {
    render(<JournalList />);
    expect(screen.getByTestId('journal-list-empty')).toBeInTheDocument();
  });

  it('shows loading state', async () => {
    const { useJournalEntries } = await import('@/hooks/useJournal');
    vi.mocked(useJournalEntries).mockReturnValue({ data: undefined, isLoading: true } as never);

    render(<JournalList />);
    expect(screen.getByTestId('journal-list-loading')).toBeInTheDocument();
  });

  it('shows entries when data loaded', async () => {
    const { useJournalEntries } = await import('@/hooks/useJournal');
    vi.mocked(useJournalEntries).mockReturnValue({
      data: {
        entries: [
          {
            _id: 'j1',
            userId: 'u1',
            symbol: 'BTCUSDT',
            interval: '1h',
            signalScore: 45,
            signalTier: 'buy',
            action: 'buy',
            entryPrice: 42000,
            exitPrice: null,
            outcomePnlPercent: null,
            notes: '',
            reviewedAt: null,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          },
        ],
      },
      isLoading: false,
    } as never);

    render(<JournalList />);
    expect(screen.getByTestId('journal-entry-card')).toBeInTheDocument();
  });

  it('renders symbol filter buttons', async () => {
    const { useJournalEntries } = await import('@/hooks/useJournal');
    vi.mocked(useJournalEntries).mockReturnValue({ data: undefined, isLoading: false } as never);

    render(<JournalList />);
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'BTC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ETH' })).toBeInTheDocument();
  });
});
