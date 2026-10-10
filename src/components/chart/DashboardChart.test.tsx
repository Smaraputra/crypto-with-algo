import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { DashboardChart } from './DashboardChart';
import { useUIStore } from '@/stores/uiStore';
import type { CandleType } from 'klinecharts';
import type { ProvisionalSignalState } from '@/hooks/useProvisionalSignal';
import { callMarks } from '@/lib/signals/track-record/chart-data';
import type { TrackBar } from '@/lib/signals/track-record/types';

const hook = vi.hoisted(() => ({ use: vi.fn(), bars: vi.fn(), panel: vi.fn() }));
vi.mock('@/hooks/useProvisionalSignal', () => ({
  useProvisionalSignal: (...args: unknown[]) => hook.use(...args),
}));
vi.mock('@/hooks/useTrackRecord', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTrackRecord')>('@/hooks/useTrackRecord');
  return {
    isTrackRecordEligible: actual.isTrackRecordEligible,
    useTrackRecordBars: (...args: unknown[]) => hook.bars(...args),
  };
});
vi.mock('./track-record/TrackRecordPanel', () => ({
  TrackRecordPanel: (props: Record<string, unknown>) => {
    hook.panel(props);
    return <div data-testid="track-record-panel" />;
  },
}));

const T0 = Date.UTC(2026, 8, 30);
const HOUR = 3_600_000;
const trackBars = () => {
  const bars = new Map<number, TrackBar>([
    [T0, { t: T0, score: 31, tier: 'buy', fwd: 0.5, source: 'rescore' }],
    [T0 + HOUR, { t: T0 + HOUR, score: -40, tier: 'strong_sell', fwd: 0.2, source: 'rescore' }],
    [T0 + 2 * HOUR, { t: T0 + 2 * HOUR, score: 5, tier: 'neutral', fwd: 0.1, source: 'rescore' }],
    [T0 + 3 * HOUR, { t: T0 + 3 * HOUR, score: 33, tier: 'buy', fwd: null, source: 'live' }],
  ]);
  return {
    bars,
    calls: callMarks(bars.values(), 0.16),
    boundary: T0 + 3 * HOUR,
    configVersion: 8,
    horizonBars: 24,
    costPercent: 0.16,
    loading: false,
    error: false,
  };
};

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
  TradingChart: ({
    symbol, interval, chartType, onIntervalChange, onChartTypeChange, signalOverlay, callsOverlay,
    onLoadedRangeChange, onVisibleRangeChange,
  }: {
    signalOverlay?: {
      visible: boolean;
      state: string | null;
      recorded: ReadonlyMap<number, { configVersion: number }>;
      rescored?: ReadonlyMap<number, unknown>;
    };
    callsOverlay?: { visible: boolean; calls: ReadonlyMap<number, unknown>; boundary: number | null };
    symbol: string;
    interval: string;
    chartType?: string;
    onIntervalChange?: (interval: string) => void;
    onChartTypeChange?: (type: CandleType) => void;
    onLoadedRangeChange?: (range: { from: number; to: number }) => void;
    onVisibleRangeChange?: (range: { from: number; to: number }) => void;
  }) => (
    <div data-testid="trading-chart" data-symbol={symbol} data-interval={interval} data-chart-type={chartType}
      data-overlay-visible={String(signalOverlay?.visible)} data-overlay-state={String(signalOverlay?.state)}
      data-recorded={[...(signalOverlay?.recorded.keys() ?? [])].join(',')}
      data-recorded-versions={[...(signalOverlay?.recorded.values() ?? [])].map((r) => r.configVersion).join(',')}
      data-rescored={[...(signalOverlay?.rescored?.keys() ?? [])].join(',')}
      data-calls-visible={String(callsOverlay?.visible)} data-calls={callsOverlay?.calls.size}
      data-boundary={String(callsOverlay?.boundary)}>
      <button onClick={() => onIntervalChange?.('5m')}>change-interval</button>
      <button onClick={() => onChartTypeChange?.('area')}>change-chart-type</button>
      <button onClick={() => onLoadedRangeChange?.({ from: T0, to: T0 + 500 * HOUR })}>report-loaded</button>
      <button onClick={() => onVisibleRangeChange?.({ from: T0, to: T0 + HOUR })}>report-visible</button>
    </div>
  ),
}));

beforeEach(() => {
  hook.use.mockReset();
  hook.use.mockReturnValue(baseSignal());
  hook.bars.mockReset();
  hook.bars.mockReturnValue(trackBars());
  hook.panel.mockReset();
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

  it('passes past calls and the hand-over line to the chart for a re-scored cell', () => {
    render(<DashboardChart />);
    const chart = screen.getByTestId('trading-chart');
    expect(chart).toHaveAttribute('data-calls-visible', 'true');
    expect(chart).toHaveAttribute('data-calls', '3');
    expect(chart).toHaveAttribute('data-boundary', String(T0 + 3 * HOUR));
  });

  it('splits re-scored bars from live bars for the score pane, live bars carrying the run version', () => {
    const recorded = new Map([[T0 + 4 * HOUR, { score: 30, tier: 'buy' as const, confidence: 90, configVersion: 8 }]]);
    hook.use.mockReturnValue(baseSignal({ recorded }));
    render(<DashboardChart />);
    const chart = screen.getByTestId('trading-chart');
    expect(chart).toHaveAttribute('data-rescored', [T0, T0 + HOUR, T0 + 2 * HOUR].join(','));
    expect(chart).toHaveAttribute('data-recorded', [T0 + 3 * HOUR, T0 + 4 * HOUR].join(','));
    expect(chart).toHaveAttribute('data-recorded-versions', '8,8');
  });

  it('asks for track bars only after the chart reports its range, and forgets it on a new symbol', () => {
    render(<DashboardChart />);
    expect(hook.bars).toHaveBeenLastCalledWith('BTCUSDT', '1h', 'day_trading', null);
    act(() => {
      screen.getByText('report-loaded').click();
    });
    expect(hook.bars).toHaveBeenLastCalledWith('BTCUSDT', '1h', 'day_trading', { from: T0, to: T0 + 500 * HOUR });
    act(() => {
      useUIStore.setState({ selectedSymbol: 'ETHUSDT' });
    });
    expect(hook.bars).toHaveBeenLastCalledWith('ETHUSDT', '1h', 'day_trading', null);
  });

  it('tallies the calls in the visible window for the panel', () => {
    render(<DashboardChart />);
    expect(hook.panel).toHaveBeenLastCalledWith(expect.objectContaining({ eligible: true, inView: null }));
    act(() => {
      screen.getByText('report-visible').click();
    });
    expect(hook.panel).toHaveBeenLastCalledWith(
      expect.objectContaining({ inView: { calls: 2, right: 1, won: 1, cost: 0, wrong: 1, pending: 0 } })
    );
  });

  it('hides past calls where the re-score has no cell', () => {
    useUIStore.setState({ selectedInterval: '1m' });
    render(<DashboardChart />);
    expect(screen.getByTestId('trading-chart')).toHaveAttribute('data-calls-visible', 'false');
    expect(hook.panel).toHaveBeenLastCalledWith(expect.objectContaining({ eligible: false }));
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
