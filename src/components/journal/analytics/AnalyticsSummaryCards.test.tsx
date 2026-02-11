import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnalyticsSummaryCards } from './AnalyticsSummaryCards';
import type { JournalAnalyticsSummary } from '@/types/journal-analytics';

const mockSummary: JournalAnalyticsSummary = {
  totalTrades: 20,
  wins: 12,
  losses: 8,
  winRate: 60,
  avgPnlPercent: 2.5,
  bestTrade: 15.3,
  worstTrade: -8.2,
  totalPnlPercent: 30.0,
  profitFactor: 2.1,
};

describe('AnalyticsSummaryCards', () => {
  it('renders summary container', () => {
    render(<AnalyticsSummaryCards summary={mockSummary} />);
    expect(screen.getByTestId('analytics-summary')).toBeInTheDocument();
  });

  it('displays total trades', () => {
    render(<AnalyticsSummaryCards summary={mockSummary} />);
    expect(screen.getByTestId('stat-total-trades')).toHaveTextContent('20');
  });

  it('displays win rate', () => {
    render(<AnalyticsSummaryCards summary={mockSummary} />);
    expect(screen.getByTestId('stat-win-rate')).toHaveTextContent('60.0%');
  });

  it('displays wins / losses', () => {
    render(<AnalyticsSummaryCards summary={mockSummary} />);
    expect(screen.getByTestId('stat-wins-/-losses')).toHaveTextContent('12 / 8');
  });

  it('displays total P&L with sign', () => {
    render(<AnalyticsSummaryCards summary={mockSummary} />);
    expect(screen.getByTestId('stat-total-p&l')).toHaveTextContent('+30.00%');
  });

  it('displays avg P&L with sign', () => {
    render(<AnalyticsSummaryCards summary={mockSummary} />);
    expect(screen.getByTestId('stat-avg-p&l')).toHaveTextContent('+2.50%');
  });

  it('displays best trade', () => {
    render(<AnalyticsSummaryCards summary={mockSummary} />);
    expect(screen.getByTestId('stat-best-trade')).toHaveTextContent('+15.30%');
  });

  it('displays worst trade', () => {
    render(<AnalyticsSummaryCards summary={mockSummary} />);
    expect(screen.getByTestId('stat-worst-trade')).toHaveTextContent('-8.20%');
  });

  it('displays profit factor', () => {
    render(<AnalyticsSummaryCards summary={mockSummary} />);
    expect(screen.getByTestId('stat-profit-factor')).toHaveTextContent('2.10');
  });

  it('displays dash for null best/worst trade', () => {
    const empty: JournalAnalyticsSummary = {
      ...mockSummary,
      bestTrade: null,
      worstTrade: null,
      profitFactor: null,
    };
    render(<AnalyticsSummaryCards summary={empty} />);
    expect(screen.getByTestId('stat-best-trade')).toHaveTextContent('-');
    expect(screen.getByTestId('stat-worst-trade')).toHaveTextContent('-');
    expect(screen.getByTestId('stat-profit-factor')).toHaveTextContent('-');
  });
});
