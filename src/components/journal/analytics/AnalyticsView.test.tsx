import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useJournalAnalytics', () => ({
  useJournalAnalytics: vi.fn(),
}));

import { AnalyticsView } from './AnalyticsView';
import { useJournalAnalytics } from '@/hooks/useJournalAnalytics';

const mockUseJournalAnalytics = vi.mocked(useJournalAnalytics);

const mockAnalytics = {
  summary: {
    totalTrades: 20,
    wins: 12,
    losses: 8,
    winRate: 60,
    avgPnlPercent: 2.5,
    bestTrade: 15,
    worstTrade: -8,
    totalPnlPercent: 30,
    profitFactor: 2.1,
  },
  byTag: [],
  byAction: [],
  bySetupType: [],
  byMarketCondition: [],
  byMonth: [],
  bySignalTier: [],
};

describe('AnalyticsView', () => {
  it('shows loading state', () => {
    mockUseJournalAnalytics.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useJournalAnalytics>);

    render(<AnalyticsView />);
    expect(screen.getByTestId('analytics-loading')).toBeInTheDocument();
  });

  it('shows error state', () => {
    mockUseJournalAnalytics.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useJournalAnalytics>);

    render(<AnalyticsView />);
    expect(screen.getByTestId('analytics-error')).toBeInTheDocument();
  });

  it('renders analytics view with data', () => {
    mockUseJournalAnalytics.mockReturnValue({
      data: mockAnalytics,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useJournalAnalytics>);

    render(<AnalyticsView />);
    expect(screen.getByTestId('analytics-view')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-summary')).toBeInTheDocument();
  });

  it('renders all section headers', () => {
    mockUseJournalAnalytics.mockReturnValue({
      data: mockAnalytics,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useJournalAnalytics>);

    render(<AnalyticsView />);
    expect(screen.getByText('Monthly P&L')).toBeInTheDocument();
    expect(screen.getByText('Trading Patterns')).toBeInTheDocument();
    expect(screen.getByText('Win Rate by Tag')).toBeInTheDocument();
    expect(screen.getByText('Signal Accuracy')).toBeInTheDocument();
    expect(screen.getByText('Performance by Setup')).toBeInTheDocument();
  });
});
