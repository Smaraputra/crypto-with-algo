import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@/components/journal/JournalFilterBar', () => ({
  JournalFilterBar: () => <div data-testid="journal-filter-bar" />,
}));

vi.mock('@/components/journal/JournalEntryList', () => ({
  JournalEntryList: () => <div data-testid="journal-entry-list" />,
}));

vi.mock('@/components/journal/ReviewQueue', () => ({
  ReviewQueue: () => <div data-testid="review-queue" />,
}));

vi.mock('@/components/journal/PlaybookView', () => ({
  PlaybookView: () => <div data-testid="playbook-view" />,
}));

vi.mock('@/components/journal/analytics/AnalyticsView', () => ({
  AnalyticsView: () => <div data-testid="analytics-view" />,
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

describe('JournalPage', () => {
  it('renders page heading', () => {
    render(<JournalPage />);
    expect(screen.getByText('Trading Journal')).toBeInTheDocument();
  });

  it('renders all tab triggers', () => {
    render(<JournalPage />);
    const tabList = screen.getByRole('tablist');
    expect(within(tabList).getByRole('tab', { name: 'Entries' })).toBeInTheDocument();
    expect(within(tabList).getByRole('tab', { name: 'Review Queue' })).toBeInTheDocument();
    expect(within(tabList).getByRole('tab', { name: 'Playbook' })).toBeInTheDocument();
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
});
