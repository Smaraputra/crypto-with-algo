import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useJournal', () => ({
  useJournalTags: vi.fn(() => ({
    data: { tags: [{ tag: 'breakout', count: 5 }, { tag: 'reversal', count: 3 }] },
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

  it('renders symbol select', () => {
    render(<JournalFilterBar filters={{}} onChange={vi.fn()} />);
    expect(screen.getByText('All Symbols')).toBeInTheDocument();
  });

  it('renders action select', () => {
    render(<JournalFilterBar filters={{}} onChange={vi.fn()} />);
    expect(screen.getByText('All Actions')).toBeInTheDocument();
  });

  it('renders condition select', () => {
    render(<JournalFilterBar filters={{}} onChange={vi.fn()} />);
    expect(screen.getByText('All Conditions')).toBeInTheDocument();
  });

  it('shows active filter badges', () => {
    render(
      <JournalFilterBar
        filters={{ symbol: 'BTCUSDT', action: 'buy' }}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByText(/symbol: BTCUSDT/)).toBeInTheDocument();
    expect(screen.getByText(/action: buy/)).toBeInTheDocument();
  });

  it('shows clear all button when filters active', () => {
    render(
      <JournalFilterBar
        filters={{ symbol: 'BTCUSDT' }}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByText('Clear all')).toBeInTheDocument();
  });

  it('does not show clear all when no filters', () => {
    render(<JournalFilterBar filters={{}} onChange={vi.fn()} />);
    expect(screen.queryByText('Clear all')).not.toBeInTheDocument();
  });
});
