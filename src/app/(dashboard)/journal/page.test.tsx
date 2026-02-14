import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@/components/journal/JournalFilterBar', () => ({
  JournalFilterBar: () => <div data-testid="journal-filter-bar" />,
}));

vi.mock('@/components/journal/JournalEntryList', () => ({
  JournalEntryList: () => <div data-testid="journal-entry-list" />,
}));

vi.mock('@/components/journal/OpenTradesView', () => ({
  OpenTradesView: () => <div data-testid="open-trades-view" />,
}));

vi.mock('@/components/journal/ClosedTradesView', () => ({
  ClosedTradesView: () => <div data-testid="closed-trades-view" />,
}));

vi.mock('@/components/journal/analytics/AnalyticsView', () => ({
  AnalyticsView: () => <div data-testid="analytics-view" />,
}));

vi.mock('@/components/journal/ManualJournalForm', () => ({
  ManualJournalForm: () => <div data-testid="manual-journal-form" />,
}));

vi.mock('@/components/journal/PnlSummaryStrip', () => ({
  PnlSummaryStrip: () => <div data-testid="pnl-summary-strip" />,
}));

vi.mock('@/hooks/useJournal', () => ({
  useJournalEntries: vi.fn(() => ({
    data: { entries: [], totalUserEntries: 10, entryLimit: 1000 },
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

import JournalPage from './page';
import { useJournalEntries } from '@/hooks/useJournal';

describe('JournalPage', () => {
  it('renders page heading', () => {
    render(<JournalPage />);
    expect(screen.getByText('Trading Journal')).toBeInTheDocument();
  });

  it('renders ManualJournalForm', () => {
    render(<JournalPage />);
    expect(screen.getByTestId('manual-journal-form')).toBeInTheDocument();
  });

  it('renders PnlSummaryStrip', () => {
    render(<JournalPage />);
    expect(screen.getByTestId('pnl-summary-strip')).toBeInTheDocument();
  });

  it('renders all tab triggers', () => {
    render(<JournalPage />);
    const tabList = screen.getByRole('tablist');
    expect(within(tabList).getByRole('tab', { name: 'Entries' })).toBeInTheDocument();
    expect(within(tabList).getByRole('tab', { name: 'Open Trades' })).toBeInTheDocument();
    expect(within(tabList).getByRole('tab', { name: 'Closed Trades' })).toBeInTheDocument();
    expect(within(tabList).getByRole('tab', { name: 'Analytics' })).toBeInTheDocument();
  });

  it('entries tab is selected by default', () => {
    render(<JournalPage />);
    const entriesTab = screen.getByRole('tab', { name: 'Entries' });
    expect(entriesTab).toHaveAttribute('data-state', 'active');
  });

  it('shows entries tab content by default', () => {
    render(<JournalPage />);
    expect(screen.getByTestId('journal-filter-bar')).toBeInTheDocument();
    expect(screen.getByTestId('journal-entry-list')).toBeInTheDocument();
  });

  it('has four tab panels configured', () => {
    render(<JournalPage />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
  });

  it('does not show entry limit warning when under 900', () => {
    render(<JournalPage />);
    expect(screen.queryByTestId('entry-limit-warning')).not.toBeInTheDocument();
  });

  it('shows entry limit warning when over 900', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [], totalUserEntries: 950, entryLimit: 1000 },
      isLoading: false,
    } as never);

    render(<JournalPage />);
    expect(screen.getByTestId('entry-limit-warning')).toBeInTheDocument();
    expect(screen.getByText(/950 of 1000/)).toBeInTheDocument();
  });
});
