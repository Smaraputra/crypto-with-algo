import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { DashboardChart } from './DashboardChart';
import { useUIStore } from '@/stores/uiStore';
import type { CandleType } from 'klinecharts';

// Mock TradingChart to avoid klinecharts canvas dependency
vi.mock('./TradingChart', () => ({
  TradingChart: ({ symbol, interval, chartType, onIntervalChange, onChartTypeChange }: {
    symbol: string;
    interval: string;
    chartType?: string;
    onIntervalChange?: (interval: string) => void;
    onChartTypeChange?: (type: CandleType) => void;
  }) => (
    <div data-testid="trading-chart" data-symbol={symbol} data-interval={interval} data-chart-type={chartType}>
      <button onClick={() => onIntervalChange?.('5m')}>change-interval</button>
      <button onClick={() => onChartTypeChange?.('area')}>change-chart-type</button>
    </div>
  ),
}));

beforeEach(() => {
  // Reset Zustand store to defaults
  useUIStore.setState({
    selectedSymbol: 'BTCUSDT',
    selectedInterval: '1h',
    chartType: 'candle_solid',
  });
});

describe('DashboardChart', () => {
  it('renders TradingChart with store defaults', () => {
    render(<DashboardChart />);

    const chart = screen.getByTestId('trading-chart');
    expect(chart).toHaveAttribute('data-symbol', 'BTCUSDT');
    expect(chart).toHaveAttribute('data-interval', '1h');
    expect(chart).toHaveAttribute('data-chart-type', 'candle_solid');
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

  it('passes chartType from store', () => {
    useUIStore.setState({ chartType: 'ohlc' });
    render(<DashboardChart />);

    expect(screen.getByTestId('trading-chart')).toHaveAttribute('data-chart-type', 'ohlc');
  });

  it('passes chart type change to store', () => {
    render(<DashboardChart />);

    act(() => {
      screen.getByText('change-chart-type').click();
    });

    expect(useUIStore.getState().chartType).toBe('area');
  });
});
