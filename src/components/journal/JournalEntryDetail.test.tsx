import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useJournal', () => ({
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

import { JournalEntryDetail } from './JournalEntryDetail';
import {
  mockJournalEntry,
  mockJournalEntry2,
  mockSkippedEntry,
} from '@/__fixtures__/journal';

describe('JournalEntryDetail', () => {
  it('renders symbol and action', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('BUY')).toBeInTheDocument();
  });

  it('renders signal score', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    expect(screen.getByText('45')).toBeInTheDocument();
  });

  it('renders tags as badges', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    // "breakout" appears as both tag badge and setupType badge
    const breakoutBadges = screen.getAllByText('breakout');
    expect(breakoutBadges.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('trend-follow')).toBeInTheDocument();
  });

  it('renders setup type badge', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    // setupType "breakout" is shown as an outline badge
    const breakoutBadges = screen.getAllByText('breakout');
    expect(breakoutBadges.length).toBe(2); // one tag + one setupType
  });

  it('renders market condition', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    expect(screen.getByText(/Trending Up/)).toBeInTheDocument();
  });

  it('renders sentiment data', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    expect(screen.getByText(/65/)).toBeInTheDocument();
    expect(screen.getByText(/Greed/)).toBeInTheDocument();
  });

  it('renders PnL for entry with exit price', () => {
    render(<JournalEntryDetail entry={mockJournalEntry2} />);
    expect(screen.getByText('+4.55%')).toBeInTheDocument();
  });

  it('renders notes via markdown preview', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    expect(screen.getByText('Strong momentum signal')).toBeInTheDocument();
  });

  it('renders lessons learned', () => {
    render(<JournalEntryDetail entry={mockJournalEntry2} />);
    expect(screen.getByText('Good entry timing, should have held longer')).toBeInTheDocument();
  });

  it('renders indicator snapshot values', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    // RSI should be in the snapshot grid
    expect(screen.getByText('RSI')).toBeInTheDocument();
    expect(screen.getByText('62.00')).toBeInTheDocument();
  });

  it('shows Reviewed badge when entry has reviewedAt', () => {
    render(<JournalEntryDetail entry={mockJournalEntry2} />);
    expect(screen.getByText('Reviewed')).toBeInTheDocument();
  });

  it('does not show review button for entries without exit price', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    expect(screen.queryByText('Review')).not.toBeInTheDocument();
  });

  it('renders skipped entry without prices', () => {
    render(<JournalEntryDetail entry={mockSkippedEntry} />);
    expect(screen.getByText('SKIP')).toBeInTheDocument();
    expect(screen.queryByText(/Entry:/)).not.toBeInTheDocument();
  });

  it('has testid', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    expect(screen.getByTestId('journal-entry-detail')).toBeInTheDocument();
  });
});
