import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { MultiStyleOverview } from './MultiStyleOverview';
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

const nullSignals = {
  scalping: null,
  day_trading: null,
  swing_trading: null,
  position_trading: null,
};

describe('MultiStyleOverview', () => {
  it('shows loading skeletons', () => {
    const { container } = render(
      <MultiStyleOverview
        signals={nullSignals}
        isLoading={true}
        activeStyle="day_trading"
        onStyleSelect={vi.fn()}
      />
    );
    const pulses = container.querySelectorAll('.animate-pulse');
    expect(pulses.length).toBe(4);
  });

  it('renders 4 style cards', () => {
    render(
      <MultiStyleOverview
        signals={nullSignals}
        isLoading={false}
        activeStyle="day_trading"
        onStyleSelect={vi.fn()}
      />
    );

    expect(screen.getByTestId('overview-scalping')).toBeInTheDocument();
    expect(screen.getByTestId('overview-day_trading')).toBeInTheDocument();
    expect(screen.getByTestId('overview-swing_trading')).toBeInTheDocument();
    expect(screen.getByTestId('overview-position_trading')).toBeInTheDocument();
  });

  it('shows "No data" for null signals', () => {
    render(
      <MultiStyleOverview
        signals={nullSignals}
        isLoading={false}
        activeStyle="day_trading"
        onStyleSelect={vi.fn()}
      />
    );

    const noDataElements = screen.getAllByText('No data');
    expect(noDataElements).toHaveLength(4);
  });

  it('shows score for available signals', () => {
    const signals = {
      ...nullSignals,
      scalping: makeSignal({ score: 55, tier: 'buy', tradingStyle: 'scalping' }),
      day_trading: makeSignal({ score: -20, tier: 'sell', tradingStyle: 'day_trading' }),
    };

    render(
      <MultiStyleOverview
        signals={signals}
        isLoading={false}
        activeStyle="day_trading"
        onStyleSelect={vi.fn()}
      />
    );

    expect(screen.getByText('+55')).toBeInTheDocument();
    expect(screen.getByText('-20')).toBeInTheDocument();
  });

  it('calls onStyleSelect when card is clicked', () => {
    const onSelect = vi.fn();

    render(
      <MultiStyleOverview
        signals={nullSignals}
        isLoading={false}
        activeStyle="day_trading"
        onStyleSelect={onSelect}
      />
    );

    fireEvent.click(screen.getByTestId('overview-scalping'));
    expect(onSelect).toHaveBeenCalledWith('scalping');
  });

  it('highlights active style card', () => {
    render(
      <MultiStyleOverview
        signals={nullSignals}
        isLoading={false}
        activeStyle="swing_trading"
        onStyleSelect={vi.fn()}
      />
    );

    const swingCard = screen.getByTestId('overview-swing_trading');
    expect(swingCard.className).toContain('border-accent');

    const scalpingCard = screen.getByTestId('overview-scalping');
    expect(scalpingCard.className).not.toContain('border-accent');
  });

  it('shows tier labels', () => {
    const signals = {
      ...nullSignals,
      scalping: makeSignal({ tier: 'strong_buy', tradingStyle: 'scalping' }),
    };

    render(
      <MultiStyleOverview
        signals={signals}
        isLoading={false}
        activeStyle="day_trading"
        onStyleSelect={vi.fn()}
      />
    );

    expect(screen.getByText('strong buy')).toBeInTheDocument();
  });
});
