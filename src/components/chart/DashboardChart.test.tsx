import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { DashboardChart } from './DashboardChart';
import { useUIStore } from '@/stores/uiStore';

// Mock TradingChart to avoid klinecharts canvas dependency
vi.mock('./TradingChart', () => ({
  TradingChart: ({ symbol, interval, onIntervalChange }: {
    symbol: string;
    interval: string;
    onIntervalChange?: (interval: string) => void;
  }) => (
    <div data-testid="trading-chart" data-symbol={symbol} data-interval={interval}>
      <button onClick={() => onIntervalChange?.('5m')}>change-interval</button>
    </div>
  ),
}));

beforeEach(() => {
  // Reset Zustand store to defaults
  useUIStore.setState({
    selectedSymbol: 'BTCUSDT',
    selectedInterval: '1h',
  });
});

describe('DashboardChart', () => {
  it('renders TradingChart with store defaults', () => {
    render(<DashboardChart />);

    const chart = screen.getByTestId('trading-chart');
    expect(chart).toHaveAttribute('data-symbol', 'BTCUSDT');
    expect(chart).toHaveAttribute('data-interval', '1h');
  });

  it('passes interval change to store', () => {
    render(<DashboardChart />);

    act(() => {
      screen.getByText('change-interval').click();
    });

    expect(useUIStore.getState().selectedInterval).toBe('5m');
  });

  it('reflects store symbol changes', () => {
    useUIStore.setState({ selectedSymbol: 'ETHUSDT' });
    render(<DashboardChart />);

    expect(screen.getByTestId('trading-chart')).toHaveAttribute('data-symbol', 'ETHUSDT');
  });
});
