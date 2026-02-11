import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MonthlyPnL } from './MonthlyPnL';
import type { MonthlyPnl } from '@/types/journal-analytics';

const mockData: MonthlyPnl[] = [
  { month: '2025-01', pnlPercent: 12.5, tradeCount: 5 },
  { month: '2025-02', pnlPercent: -4.2, tradeCount: 3 },
  { month: '2025-03', pnlPercent: 8.0, tradeCount: 4 },
];

describe('MonthlyPnL', () => {
  it('shows empty state when no data', () => {
    render(<MonthlyPnL data={[]} />);
    expect(screen.getByTestId('monthly-pnl-empty')).toBeInTheDocument();
  });

  it('renders monthly bars', () => {
    render(<MonthlyPnL data={mockData} />);
    expect(screen.getByTestId('monthly-pnl')).toBeInTheDocument();
  });

  it('shows month labels', () => {
    render(<MonthlyPnL data={mockData} />);
    expect(screen.getByText('2025-01')).toBeInTheDocument();
    expect(screen.getByText('2025-02')).toBeInTheDocument();
    expect(screen.getByText('2025-03')).toBeInTheDocument();
  });

  it('shows P&L values with sign', () => {
    render(<MonthlyPnL data={mockData} />);
    expect(screen.getByText('+12.50%')).toBeInTheDocument();
    expect(screen.getByText('-4.20%')).toBeInTheDocument();
    expect(screen.getByText('+8.00%')).toBeInTheDocument();
  });

  it('shows trade counts', () => {
    render(<MonthlyPnL data={mockData} />);
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('renders green bar for positive months', () => {
    render(<MonthlyPnL data={mockData} />);
    const bar = screen.getByTestId('bar-2025-01');
    expect(bar).toHaveStyle({ backgroundColor: '#0ecb81' });
  });

  it('renders red bar for negative months', () => {
    render(<MonthlyPnL data={mockData} />);
    const bar = screen.getByTestId('bar-2025-02');
    expect(bar).toHaveStyle({ backgroundColor: '#f6465d' });
  });
});
