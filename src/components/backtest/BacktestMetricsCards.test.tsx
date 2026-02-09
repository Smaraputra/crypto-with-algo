import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BacktestMetricsCards } from './BacktestMetricsCards';
import type { BacktestMetrics } from '@/lib/backtest/types';

const mockMetrics: BacktestMetrics = {
  totalPnl: 1500.50,
  totalPnlPercent: 15.05,
  totalTrades: 25,
  winningTrades: 15,
  losingTrades: 10,
  winRate: 0.6,
  profitFactor: 2.1,
  maxDrawdown: 500,
  maxDrawdownPercent: 5.0,
  sharpeRatio: 1.85,
  sortinoRatio: 2.3,
  calmarRatio: 3.0,
  avgWin: 200,
  avgLoss: -100,
  avgWinPercent: 2.0,
  avgLossPercent: -1.0,
  totalFees: 25.5,
  maxConsecutiveWins: 5,
  maxConsecutiveLosses: 3,
};

describe('BacktestMetricsCards', () => {
  it('renders metrics container', () => {
    render(<BacktestMetricsCards metrics={mockMetrics} />);
    expect(screen.getByTestId('backtest-metrics')).toBeInTheDocument();
  });

  it('displays Total PnL', () => {
    render(<BacktestMetricsCards metrics={mockMetrics} />);
    expect(screen.getByText('Total PnL')).toBeInTheDocument();
  });

  it('displays Win Rate', () => {
    render(<BacktestMetricsCards metrics={mockMetrics} />);
    expect(screen.getByText('Win Rate')).toBeInTheDocument();
    expect(screen.getByText('60.0%')).toBeInTheDocument();
  });

  it('displays Profit Factor', () => {
    render(<BacktestMetricsCards metrics={mockMetrics} />);
    expect(screen.getByText('Profit Factor')).toBeInTheDocument();
    expect(screen.getByText('2.10')).toBeInTheDocument();
  });

  it('displays Sharpe Ratio', () => {
    render(<BacktestMetricsCards metrics={mockMetrics} />);
    expect(screen.getByText('Sharpe Ratio')).toBeInTheDocument();
    expect(screen.getByText('1.85')).toBeInTheDocument();
  });

  it('displays total trades count', () => {
    render(<BacktestMetricsCards metrics={mockMetrics} />);
    expect(screen.getByText('Total Trades')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
  });

  it('displays winning/losing breakdown', () => {
    render(<BacktestMetricsCards metrics={mockMetrics} />);
    expect(screen.getByText('15 / 10')).toBeInTheDocument();
  });

  it('handles infinite profit factor', () => {
    render(<BacktestMetricsCards metrics={{ ...mockMetrics, profitFactor: Infinity }} />);
    expect(screen.getByText('inf')).toBeInTheDocument();
  });
});
