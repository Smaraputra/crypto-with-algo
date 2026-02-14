import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/useJournal', () => ({
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

  it('renders signal score in context row', () => {
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
    // setupType "breakout" shown as outline badge in context row
    // and "breakout" also in tags -- there should be 2 occurrences
    const breakoutBadges = screen.getAllByText('breakout');
    expect(breakoutBadges.length).toBe(2);
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
    expect(screen.getByTestId('entry-pnl')).toHaveTextContent('+4.55%');
  });

  it('renders collapsible notes toggle', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    expect(screen.getByTestId('toggle-notes')).toBeInTheDocument();
  });

  it('expands notes on toggle click', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    fireEvent.click(screen.getByTestId('toggle-notes'));
    expect(screen.getByText('Strong momentum signal')).toBeInTheDocument();
  });

  it('renders lessons learned', () => {
    render(<JournalEntryDetail entry={mockJournalEntry2} />);
    expect(screen.getByText('Good entry timing, should have held longer')).toBeInTheDocument();
  });

  it('renders collapsible indicator snapshot toggle', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    expect(screen.getByTestId('toggle-snapshot')).toBeInTheDocument();
  });

  it('expands snapshot on toggle click', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    fireEvent.click(screen.getByTestId('toggle-snapshot'));
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

  it('shows close trade button for open trades', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    expect(screen.getByText('Close Trade')).toBeInTheDocument();
  });

  it('renders skipped entry without prices', () => {
    render(<JournalEntryDetail entry={mockSkippedEntry} />);
    expect(screen.getByText('SKIP')).toBeInTheDocument();
    expect(screen.queryByText(/Entry/)).not.toBeInTheDocument();
  });

  it('renders entry actions menu trigger', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    expect(screen.getByTestId('entry-actions-trigger')).toBeInTheDocument();
  });

  it('has testid', () => {
    render(<JournalEntryDetail entry={mockJournalEntry} />);
    expect(screen.getByTestId('journal-entry-detail')).toBeInTheDocument();
  });

  it('shows entry and exit prices prominently', () => {
    render(<JournalEntryDetail entry={mockJournalEntry2} />);
    expect(screen.getByText('$2,200')).toBeInTheDocument();
    expect(screen.getByText('$2,100')).toBeInTheDocument();
  });
});
