import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TradeList } from './TradeList';
import type { BacktestTrade } from '@/lib/backtest/types';

const mockTrades: BacktestTrade[] = [
  {
    entryBar: 10,
    exitBar: 15,
    entryTime: 1704067200000,
    exitTime: 1704085200000,
    side: 'long',
    entryPrice: 42000,
    exitPrice: 43000,
    quantity: 0.1,
    pnl: 100,
    pnlPercent: 2.38,
    fees: 8.5,
    exitReason: 'signal',
    entryScore: 45,
    exitScore: -15,
    entryTier: 'buy',
    holdTimeBars: 5,
  },
  {
    entryBar: 20,
    exitBar: 25,
    entryTime: 1704110400000,
    exitTime: 1704128400000,
    side: 'long',
    entryPrice: 43500,
    exitPrice: 42500,
    quantity: 0.1,
    pnl: -100,
    pnlPercent: -2.3,
    fees: 8.6,
    exitReason: 'stop_loss',
    entryScore: 35,
    exitScore: -5,
    entryTier: 'buy',
    holdTimeBars: 5,
  },
];

describe('TradeList', () => {
  it('renders trade table with data', () => {
    render(<TradeList trades={mockTrades} />);
    expect(screen.getByTestId('trade-list')).toBeInTheDocument();
  });

  it('shows empty state when no trades', () => {
    render(<TradeList trades={[]} />);
    expect(screen.getByTestId('trade-list-empty')).toBeInTheDocument();
    expect(screen.getByText('No trades generated')).toBeInTheDocument();
  });

  it('displays trade numbers', () => {
    render(<TradeList trades={mockTrades} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('displays trade sides', () => {
    render(<TradeList trades={mockTrades} />);
    const longElements = screen.getAllByText('LONG');
    expect(longElements).toHaveLength(2);
  });

  it('displays PnL with sign', () => {
    render(<TradeList trades={mockTrades} />);
    expect(screen.getByText('+100.00')).toBeInTheDocument();
    expect(screen.getByText('-100.00')).toBeInTheDocument();
  });

  it('displays exit reason', () => {
    render(<TradeList trades={mockTrades} />);
    expect(screen.getByText('signal')).toBeInTheDocument();
    expect(screen.getByText('stop loss')).toBeInTheDocument();
  });

  it('renders table headers', () => {
    render(<TradeList trades={mockTrades} />);
    expect(screen.getByText('Entry')).toBeInTheDocument();
    expect(screen.getByText('Exit')).toBeInTheDocument();
    expect(screen.getByText('Side')).toBeInTheDocument();
    expect(screen.getByText('PnL')).toBeInTheDocument();
  });
});
