import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { AutoUpdateStatus } from './AutoUpdateStatus';

describe('AutoUpdateStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows "No signals computed yet" when lastUpdated is null', () => {
    render(<AutoUpdateStatus tradingStyle="day_trading" lastUpdated={null} />);
    expect(screen.getByText('No signals computed yet')).toBeInTheDocument();
  });

  it('renders with data-testid', () => {
    render(<AutoUpdateStatus tradingStyle="scalping" lastUpdated={null} />);
    expect(screen.getByTestId('auto-update-status')).toBeInTheDocument();
  });

  it('shows relative time for last update', () => {
    const fiveMinAgo = new Date('2024-01-15T11:55:00Z').toISOString();
    render(<AutoUpdateStatus tradingStyle="day_trading" lastUpdated={fiveMinAgo} />);
    expect(screen.getByText('Last: 5m ago')).toBeInTheDocument();
  });

  it('shows countdown to next update', () => {
    // day_trading updateFrequencyMs = 300_000 (5 min)
    // Last updated 2 minutes ago => next in 3 minutes
    const twoMinAgo = new Date('2024-01-15T11:58:00Z').toISOString();
    render(<AutoUpdateStatus tradingStyle="day_trading" lastUpdated={twoMinAgo} />);
    expect(screen.getByText('Next: 3m 0s')).toBeInTheDocument();
  });

  it('shows "now" when next update is overdue', () => {
    // Scalping updateFrequencyMs = 60_000 (1 min)
    // Last updated 2 minutes ago => overdue
    const twoMinAgo = new Date('2024-01-15T11:58:00Z').toISOString();
    render(<AutoUpdateStatus tradingStyle="scalping" lastUpdated={twoMinAgo} />);
    expect(screen.getByText('Next: now')).toBeInTheDocument();
  });

  it('shows seconds for recent updates', () => {
    const thirtySecAgo = new Date('2024-01-15T11:59:30Z').toISOString();
    render(<AutoUpdateStatus tradingStyle="scalping" lastUpdated={thirtySecAgo} />);
    expect(screen.getByText('Last: 30s ago')).toBeInTheDocument();
  });
});
