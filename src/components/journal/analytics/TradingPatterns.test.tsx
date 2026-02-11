import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TradingPatterns } from './TradingPatterns';
import type { JournalAnalyticsSummary, MonthlyPnl } from '@/types/journal-analytics';

const baseSummary: JournalAnalyticsSummary = {
  totalTrades: 10,
  wins: 5,
  losses: 5,
  winRate: 50,
  avgPnlPercent: 1.0,
  bestTrade: 10,
  worstTrade: -5,
  totalPnlPercent: 5,
  profitFactor: 1.2,
};

describe('TradingPatterns', () => {
  it('renders patterns container', () => {
    render(<TradingPatterns summary={baseSummary} byMonth={[]} />);
    expect(screen.getByTestId('trading-patterns')).toBeInTheDocument();
  });

  it('shows insufficient data when no patterns detected', () => {
    render(<TradingPatterns summary={baseSummary} byMonth={[]} />);
    expect(screen.getByText('Insufficient Data')).toBeInTheDocument();
  });

  it('detects strong win rate', () => {
    const summary: JournalAnalyticsSummary = {
      ...baseSummary,
      wins: 8,
      losses: 2,
      winRate: 80,
    };
    render(<TradingPatterns summary={summary} byMonth={[]} />);
    expect(screen.getByText('Strong Win Rate')).toBeInTheDocument();
  });

  it('detects low win rate', () => {
    const summary: JournalAnalyticsSummary = {
      ...baseSummary,
      wins: 2,
      losses: 8,
      winRate: 20,
    };
    render(<TradingPatterns summary={summary} byMonth={[]} />);
    expect(screen.getByText('Low Win Rate')).toBeInTheDocument();
  });

  it('detects high profit factor', () => {
    const summary: JournalAnalyticsSummary = {
      ...baseSummary,
      profitFactor: 2.5,
    };
    render(<TradingPatterns summary={summary} byMonth={[]} />);
    expect(screen.getByText('High Profit Factor')).toBeInTheDocument();
  });

  it('detects negative expectancy', () => {
    const summary: JournalAnalyticsSummary = {
      ...baseSummary,
      profitFactor: 0.7,
    };
    render(<TradingPatterns summary={summary} byMonth={[]} />);
    expect(screen.getByText('Negative Expectancy')).toBeInTheDocument();
  });

  it('detects consistent monthly profits', () => {
    const months: MonthlyPnl[] = [
      { month: '2025-01', pnlPercent: 5, tradeCount: 3 },
      { month: '2025-02', pnlPercent: 3, tradeCount: 2 },
      { month: '2025-03', pnlPercent: 7, tradeCount: 4 },
      { month: '2025-04', pnlPercent: -1, tradeCount: 2 },
    ];
    render(<TradingPatterns summary={baseSummary} byMonth={months} />);
    expect(screen.getByText('Consistent Monthly Profits')).toBeInTheDocument();
  });

  it('detects losing streak', () => {
    const months: MonthlyPnl[] = [
      { month: '2025-01', pnlPercent: -2, tradeCount: 3 },
      { month: '2025-02', pnlPercent: -3, tradeCount: 2 },
      { month: '2025-03', pnlPercent: -1, tradeCount: 4 },
    ];
    render(<TradingPatterns summary={baseSummary} byMonth={months} />);
    expect(screen.getByText('Losing Streak')).toBeInTheDocument();
  });

  it('detects possible overtrading', () => {
    const months: MonthlyPnl[] = [
      { month: '2025-01', pnlPercent: 5, tradeCount: 3 },
      { month: '2025-02', pnlPercent: 2, tradeCount: 4 },
      { month: '2025-03', pnlPercent: -10, tradeCount: 15 },
    ];
    render(<TradingPatterns summary={baseSummary} byMonth={months} />);
    expect(screen.getByText('Possible Overtrading')).toBeInTheDocument();
  });
});
