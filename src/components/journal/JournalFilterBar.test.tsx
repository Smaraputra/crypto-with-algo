import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useJournal', () => ({
  useJournalTags: vi.fn(() => ({
    data: { tags: [{ tag: 'breakout', count: 5 }, { tag: 'reversal', count: 3 }] },
  })),
  useJournalEntries: vi.fn(() => ({
    data: { entries: [] },
    isLoading: false,
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

import { JournalFilterBar } from './JournalFilterBar';

describe('JournalFilterBar', () => {
  it('renders filter bar', () => {
    render(<JournalFilterBar filters={{}} onChange={vi.fn()} />);
    expect(screen.getByTestId('journal-filter-bar')).toBeInTheDocument();
  });

  it('renders filter trigger button', () => {
    render(<JournalFilterBar filters={{}} onChange={vi.fn()} />);
    expect(screen.getByTestId('filter-trigger')).toBeInTheDocument();
    expect(screen.getByText('Filters')).toBeInTheDocument();
  });

  it('renders export button', () => {
    render(<JournalFilterBar filters={{}} onChange={vi.fn()} />);
    expect(screen.getByTestId('export-csv-button')).toBeInTheDocument();
  });

  it('shows active filter count when filters are set', () => {
    render(
      <JournalFilterBar
        filters={{ symbol: 'BTCUSDT', action: 'buy' }}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('active-filter-count')).toHaveTextContent('2');
  });

  it('does not show filter count when no active filters', () => {
    render(<JournalFilterBar filters={{}} onChange={vi.fn()} />);
    expect(screen.queryByTestId('active-filter-count')).not.toBeInTheDocument();
  });

  it('does not count page/limit/sort in active filters', () => {
    render(
      <JournalFilterBar
        filters={{ page: 2, limit: 20, sort: '-createdAt', symbol: 'BTCUSDT' }}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('active-filter-count')).toHaveTextContent('1');
  });
});
