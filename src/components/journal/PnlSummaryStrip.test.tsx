import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useJournalAnalytics', () => ({
  useJournalAnalytics: vi.fn(),
}));

import { PnlSummaryStrip } from './PnlSummaryStrip';
import { useJournalAnalytics } from '@/hooks/useJournalAnalytics';

describe('PnlSummaryStrip', () => {
  it('shows loading state', () => {
    vi.mocked(useJournalAnalytics).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useJournalAnalytics>);

    render(<PnlSummaryStrip />);
    expect(screen.getByTestId('pnl-strip-loading')).toBeInTheDocument();
  });

  it('displays summary stats', () => {
    vi.mocked(useJournalAnalytics).mockReturnValue({
      data: {
        summary: {
          totalTrades: 10,
          wins: 6,
          losses: 4,
          winRate: 60,
          avgPnlPercent: 2.5,
          bestTrade: 15,
          worstTrade: -5,
          totalPnlPercent: 25,
          profitFactor: 2.5,
        },
        incompleteTradeCount: 0,
        byTag: [],
        byAction: [],
        bySetupType: [],
        byMarketCondition: [],
        byMonth: [],
        bySignalTier: [],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useJournalAnalytics>);

    render(<PnlSummaryStrip />);
    expect(screen.getByTestId('pnl-summary-strip')).toBeInTheDocument();
    expect(screen.getByText('+25.00%')).toBeInTheDocument();
    expect(screen.getByText('60.0%')).toBeInTheDocument();
    expect(screen.getByText('2.50')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('shows dash for win rate when no closed trades', () => {
    vi.mocked(useJournalAnalytics).mockReturnValue({
      data: {
        summary: {
          totalTrades: 3,
          wins: 0,
          losses: 0,
          winRate: 0,
          avgPnlPercent: 0,
          bestTrade: null,
          worstTrade: null,
          totalPnlPercent: 0,
          profitFactor: null,
        },
        incompleteTradeCount: 0,
        byTag: [],
        byAction: [],
        bySetupType: [],
        byMarketCondition: [],
        byMonth: [],
        bySignalTier: [],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useJournalAnalytics>);

    render(<PnlSummaryStrip />);
    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });
});
