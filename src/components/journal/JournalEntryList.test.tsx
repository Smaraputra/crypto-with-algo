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

import { JournalEntryList } from './JournalEntryList';
import { useJournalEntries } from '@/hooks/useJournal';
import { mockJournalEntries } from '@/__fixtures__/journal';

describe('JournalEntryList', () => {
  it('shows loading skeletons', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useJournalEntries>);

    render(<JournalEntryList filters={{}} onPageChange={vi.fn()} />);
    expect(screen.getByTestId('journal-list-loading')).toBeInTheDocument();
  });

  it('shows empty state', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [], total: 0, page: 1, totalPages: 0 },
      isLoading: false,
    } as unknown as ReturnType<typeof useJournalEntries>);

    render(<JournalEntryList filters={{}} onPageChange={vi.fn()} />);
    expect(screen.getByTestId('journal-list-empty')).toBeInTheDocument();
  });

  it('renders entries', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: mockJournalEntries, total: 3, page: 1, totalPages: 1 },
      isLoading: false,
    } as unknown as ReturnType<typeof useJournalEntries>);

    render(<JournalEntryList filters={{}} onPageChange={vi.fn()} />);
    expect(screen.getByTestId('journal-entry-list')).toBeInTheDocument();
    // 3 entries rendered as JournalEntryDetail
    const details = screen.getAllByTestId('journal-entry-detail');
    expect(details).toHaveLength(3);
  });

  it('shows pagination when multiple pages', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: mockJournalEntries, total: 30, page: 1, totalPages: 3 },
      isLoading: false,
    } as unknown as ReturnType<typeof useJournalEntries>);

    render(<JournalEntryList filters={{}} onPageChange={vi.fn()} />);
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByText('Previous')).toBeDisabled();
    expect(screen.getByText('Next')).not.toBeDisabled();
  });

  it('hides pagination for single page', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: mockJournalEntries, total: 3, page: 1, totalPages: 1 },
      isLoading: false,
    } as unknown as ReturnType<typeof useJournalEntries>);

    render(<JournalEntryList filters={{}} onPageChange={vi.fn()} />);
    expect(screen.queryByText('Previous')).not.toBeInTheDocument();
  });
});
