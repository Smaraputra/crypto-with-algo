import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { SignalTimeline } from './SignalTimeline';
import type { GlobalSignalRecord } from '@/hooks/useSignals';

function makeSignal(overrides: Partial<GlobalSignalRecord> = {}): GlobalSignalRecord {
  return {
    _id: 'gs1',
    symbol: 'BTCUSDT',
    interval: '15m',
    tradingStyle: 'day_trading',
    score: 45,
    tier: 'buy',
    confidence: 72,
    components: [],
    configVersion: 1,
    candleTimestamp: Date.now(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SignalTimeline', () => {
  it('shows loading skeleton', () => {
    const { container } = render(<SignalTimeline signals={[]} isLoading={true} />);
    const pulses = container.querySelectorAll('.animate-pulse');
    expect(pulses.length).toBeGreaterThan(0);
  });

  it('shows empty message when no signals', () => {
    render(<SignalTimeline signals={[]} isLoading={false} />);
    expect(screen.getByText('No signal history available.')).toBeInTheDocument();
  });

  it('renders signal table', () => {
    const signals = [
      makeSignal({ _id: 'gs1', score: 55, tier: 'buy', interval: '15m' }),
      makeSignal({ _id: 'gs2', score: -20, tier: 'sell', interval: '1h' }),
    ];
    render(<SignalTimeline signals={signals} isLoading={false} />);

    expect(screen.getByTestId('signal-timeline')).toBeInTheDocument();
    expect(screen.getByText('+55')).toBeInTheDocument();
    expect(screen.getByText('-20')).toBeInTheDocument();
    expect(screen.getByText('15m')).toBeInTheDocument();
    expect(screen.getByText('1h')).toBeInTheDocument();
  });

  it('renders sparkline with enough data points', () => {
    const signals = [
      makeSignal({ _id: 'gs1', score: 55 }),
      makeSignal({ _id: 'gs2', score: 30 }),
      makeSignal({ _id: 'gs3', score: -10 }),
    ];
    render(<SignalTimeline signals={signals} isLoading={false} />);

    expect(screen.getByTestId('signal-sparkline')).toBeInTheDocument();
  });

  it('shows tier labels', () => {
    const signals = [
      makeSignal({ _id: 'gs1', tier: 'strong_buy' }),
    ];
    render(<SignalTimeline signals={signals} isLoading={false} />);

    expect(screen.getByText('strong buy')).toBeInTheDocument();
  });

  it('shows confidence percentage', () => {
    const signals = [
      makeSignal({ _id: 'gs1', confidence: 85 }),
    ];
    render(<SignalTimeline signals={signals} isLoading={false} />);

    expect(screen.getByText('85%')).toBeInTheDocument();
  });
});
