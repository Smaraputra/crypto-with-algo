import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionBreakdown } from './SessionBreakdown';
import type { SessionBreakdownEntry } from '@/lib/backtest/types';

const breakdown: SessionBreakdownEntry[] = [
  { session: 'asia', trades: 10, wins: 6, winRate: 0.6, totalPnl: 120.5, avgPnlPercent: 1.2 },
  { session: 'ny_overlap', trades: 4, wins: 1, winRate: 0.25, totalPnl: -45.25, avgPnlPercent: -1.1 },
];

describe('SessionBreakdown', () => {
  it('renders a row per session with formatted values', () => {
    render(<SessionBreakdown breakdown={breakdown} />);

    expect(screen.getByTestId('session-breakdown')).toBeInTheDocument();
    expect(screen.getByText('Asia')).toBeInTheDocument();
    expect(screen.getByText('London/NY Overlap')).toBeInTheDocument();
    expect(screen.getByText('60.0%')).toBeInTheDocument();
    expect(screen.getByText('+120.50')).toBeInTheDocument();
    expect(screen.getByText('-45.25')).toBeInTheDocument();
    expect(screen.getByText('-1.10%')).toBeInTheDocument();
  });

  it('renders nothing for an empty breakdown', () => {
    const { container } = render(<SessionBreakdown breakdown={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
