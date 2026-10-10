import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { DashboardChart } from './DashboardChart';
import { useUIStore } from '@/stores/uiStore';
import type { CandleType } from 'klinecharts';
import type { ProvisionalSignalState } from '@/hooks/useProvisionalSignal';

const hook = vi.hoisted(() => ({ use: vi.fn() }));
vi.mock('@/hooks/useProvisionalSignal', () => ({
  useProvisionalSignal: (...args: unknown[]) => hook.use(...args),
}));

const baseSignal = (over: Partial<ProvisionalSignalState> = {}): ProvisionalSignalState => ({
  status: 'loading',
  reason: null,
  reasonCode: null,
  provisional: null,
  recorded: new Map(),
  configVersion: 8,
  lastComputeMs: null,
  ...over,
});

// Mock TradingChart to avoid klinecharts canvas dependency
vi.mock('./TradingChart', () => ({
  TradingChart: ({ symbol, interval, chartType, onIntervalChange, onChartTypeChange, signalOverlay }: {
    signalOverlay?: { visible: boolean; state: string | null };
    symbol: string;
    interval: string;
    chartType?: string;
    onIntervalChange?: (interval: string) => void;
    onChartTypeChange?: (type: CandleType) => void;
  }) => (
    <div data-testid="trading-chart" data-symbol={symbol} data-interval={interval} data-chart-type={chartType}
      data-overlay-visible={String(signalOverlay?.visible)} data-overlay-state={String(signalOverlay?.state)}>
      <button onClick={() => onIntervalChange?.('5m')}>change-interval</button>
      <button onClick={() => onChartTypeChange?.('area')}>change-chart-type</button>
    </div>
  ),
}));

beforeEach(() => {
  hook.use.mockReset();
  hook.use.mockReturnValue(baseSignal());
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

  it('asks the hook for the first style of the interval and shows the strip under the chart', () => {
    render(<DashboardChart />);
    expect(hook.use).toHaveBeenLastCalledWith('BTCUSDT', '1h', 'day_trading');
    expect(screen.getByRole('heading')).toHaveTextContent('Signal score · Day trading · 1h');
    expect(screen.queryByRole('button', { name: 'Position' })).toBeNull();
  });

  it('shows the overlay while loading and passes the provisional state through', () => {
    hook.use.mockReturnValue(baseSignal({ status: 'awaiting-record' }));
    render(<DashboardChart />);
    const chart = screen.getByTestId('trading-chart');
    expect(chart).toHaveAttribute('data-overlay-visible', 'true');
    expect(chart).toHaveAttribute('data-overlay-state', 'awaiting-record');
  });

  it('hides the overlay when unavailable', () => {
    hook.use.mockReturnValue(baseSignal({ status: 'unavailable' }));
    render(<DashboardChart />);
    expect(screen.getByTestId('trading-chart')).toHaveAttribute('data-overlay-visible', 'false');
    expect(screen.getByTestId('signal-score-status')).toHaveTextContent('No scheduler score for BTCUSDT at 1h.');
  });

  it('offers Swing and Position at 1d and passes the pick to the hook', () => {
    useUIStore.setState({ selectedInterval: '1d' });
    render(<DashboardChart />);
    expect(hook.use).toHaveBeenLastCalledWith('BTCUSDT', '1d', 'swing_trading');
    act(() => {
      screen.getByRole('button', { name: 'Position' }).click();
    });
    expect(hook.use).toHaveBeenLastCalledWith('BTCUSDT', '1d', 'position_trading');
    expect(screen.getByRole('button', { name: 'Position' })).toHaveAttribute('aria-pressed', 'true');
  });
});
