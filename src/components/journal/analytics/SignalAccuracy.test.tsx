import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignalAccuracy } from './SignalAccuracy';
import type { SignalTierAccuracy } from '@/types/journal-analytics';

const mockData: SignalTierAccuracy[] = [
  { tier: 'strong_buy', count: 5, avgPnlPercent: 8.5, winRate: 80 },
  { tier: 'buy', count: 10, avgPnlPercent: 2.1, winRate: 60 },
  { tier: 'sell', count: 3, avgPnlPercent: -1.5, winRate: 33.3 },
];

describe('SignalAccuracy', () => {
  it('shows empty state when no data', () => {
    render(<SignalAccuracy data={[]} />);
    expect(screen.getByTestId('signal-accuracy-empty')).toBeInTheDocument();
  });

  it('renders signal accuracy table', () => {
    render(<SignalAccuracy data={mockData} />);
    expect(screen.getByTestId('signal-accuracy')).toBeInTheDocument();
  });

  it('shows tier labels', () => {
    render(<SignalAccuracy data={mockData} />);
    expect(screen.getByText('Strong Buy')).toBeInTheDocument();
    expect(screen.getByText('Buy')).toBeInTheDocument();
    expect(screen.getByText('Sell')).toBeInTheDocument();
  });

  it('shows trade counts', () => {
    render(<SignalAccuracy data={mockData} />);
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows win rates', () => {
    render(<SignalAccuracy data={mockData} />);
    expect(screen.getByText('80.0%')).toBeInTheDocument();
    expect(screen.getByText('60.0%')).toBeInTheDocument();
    expect(screen.getByText('33.3%')).toBeInTheDocument();
  });

  it('shows avg P&L with sign', () => {
    render(<SignalAccuracy data={mockData} />);
    expect(screen.getByText('+8.50%')).toBeInTheDocument();
    expect(screen.getByText('+2.10%')).toBeInTheDocument();
    expect(screen.getByText('-1.50%')).toBeInTheDocument();
  });
});
