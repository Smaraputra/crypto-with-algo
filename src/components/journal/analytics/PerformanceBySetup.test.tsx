import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PerformanceBySetup } from './PerformanceBySetup';
import type { SetupPerformance } from '@/types/journal-analytics';

const mockData: SetupPerformance[] = [
  { setupType: 'breakout', count: 8, wins: 5, losses: 3, winRate: 62.5, avgPnlPercent: 4.1 },
  { setupType: 'reversal', count: 4, wins: 1, losses: 3, winRate: 25.0, avgPnlPercent: -2.3 },
];

describe('PerformanceBySetup', () => {
  it('shows empty state when no data', () => {
    render(<PerformanceBySetup data={[]} />);
    expect(screen.getByTestId('setup-empty')).toBeInTheDocument();
  });

  it('renders table with setup types', () => {
    render(<PerformanceBySetup data={mockData} />);
    expect(screen.getByTestId('performance-by-setup')).toBeInTheDocument();
    expect(screen.getByText('breakout')).toBeInTheDocument();
    expect(screen.getByText('reversal')).toBeInTheDocument();
  });

  it('shows trade counts', () => {
    render(<PerformanceBySetup data={mockData} />);
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('shows win rates', () => {
    render(<PerformanceBySetup data={mockData} />);
    expect(screen.getByText('62.5%')).toBeInTheDocument();
    expect(screen.getByText('25.0%')).toBeInTheDocument();
  });

  it('shows avg P&L with sign', () => {
    render(<PerformanceBySetup data={mockData} />);
    expect(screen.getByText('+4.10%')).toBeInTheDocument();
    expect(screen.getByText('-2.30%')).toBeInTheDocument();
  });

  it('renders table headers', () => {
    render(<PerformanceBySetup data={mockData} />);
    expect(screen.getByText('Setup Type')).toBeInTheDocument();
    expect(screen.getByText('Trades')).toBeInTheDocument();
    expect(screen.getByText('Win Rate')).toBeInTheDocument();
    expect(screen.getByText('Avg P&L')).toBeInTheDocument();
  });
});
