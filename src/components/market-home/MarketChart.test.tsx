import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketChart } from './MarketChart';
import { useTradingChartEngine } from '@/components/chart/useTradingChartEngine';
import { useUIStore } from '@/stores/uiStore';

const mockUseChartCalls = vi.fn();

vi.mock('@/components/chart/useTradingChartEngine', () => ({
  useTradingChartEngine: vi.fn(),
}));

vi.mock('@/hooks/useChartCalls', () => ({
  useChartCalls: (...args: unknown[]) => mockUseChartCalls(...args),
}));

describe('MarketChart', () => {
  const handleRefreshMock = vi.fn();
  const setSelectedIntervalMock = vi.fn();

  const mockCallsOverlay = {
    visible: true,
    calls: new Map(),
    boundary: null,
    horizonBars: 24,
    costPercent: 0.16,
  };

  const defaultCallsReturn = {
    eligible: true,
    ineligibleReason: null,
    show: true,
    setShow: vi.fn(),
    callsOverlay: mockCallsOverlay,
    onLoadedRangeChange: vi.fn(),
    onVisibleRangeChange: vi.fn(),
    tally: null,
    loading: false,
    error: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({
      selectedSymbol: 'BTCUSDT',
      selectedInterval: '1h',
      setSelectedInterval: setSelectedIntervalMock,
    });

    mockUseChartCalls.mockReturnValue(defaultCallsReturn);

    vi.mocked(useTradingChartEngine).mockReturnValue({
      containerRef: { current: null },
      isLoading: false,
      historyError: false,
      handleRefresh: handleRefreshMock,
      hoverCall: null,
      callsHorizon: 24,
      callsCost: 0.16,
    } as unknown as ReturnType<typeof useTradingChartEngine>);
  });

  it('renders loading status when engine is loading', () => {
    vi.mocked(useTradingChartEngine).mockReturnValue({
      containerRef: { current: null },
      isLoading: true,
      historyError: false,
      handleRefresh: handleRefreshMock,
      hoverCall: null,
      callsHorizon: 24,
      callsCost: 0.16,
    } as unknown as ReturnType<typeof useTradingChartEngine>);

    render(<MarketChart />);
    expect(screen.getByText('Loading the chart.')).toBeInTheDocument();
  });

  it('renders error notice and calls refresh when Try again is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(useTradingChartEngine).mockReturnValue({
      containerRef: { current: null },
      isLoading: false,
      historyError: true,
      handleRefresh: handleRefreshMock,
      hoverCall: null,
      callsHorizon: 24,
      callsCost: 0.16,
    } as unknown as ReturnType<typeof useTradingChartEngine>);

    render(<MarketChart />);

    expect(screen.getByText('The chart did not load.')).toBeInTheDocument();
    expect(
      screen.getByText('Price history did not answer. Try again in a minute.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Show calls' })).not.toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'Try again' });
    await user.click(button);
    expect(handleRefreshMock).toHaveBeenCalledTimes(1);
  });

  it('interval control sets the store and maps 1W to 1w, and unsupported intervals fall back to 1h', async () => {
    const user = userEvent.setup();
    useUIStore.setState({ selectedInterval: '15m' }); // unsupported stored interval

    render(<MarketChart />);

    // 1H should be selected because 15m is not in the allowed list
    const radio1H = screen.getByRole('radio', { name: '1H' });
    expect(radio1H).toBeChecked();

    const label1W = screen.getByText('1W');
    await user.click(label1W);

    expect(setSelectedIntervalMock).toHaveBeenCalledWith('1w');
  });

  it('passes initialIndicators: [], showCandleTooltip: false, restoreOverlays: false and callsOverlay to useTradingChartEngine', () => {
    render(<MarketChart />);

    expect(useTradingChartEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        initialIndicators: [],
        showCandleTooltip: false,
        restoreOverlays: false,
        callsOverlay: mockCallsOverlay,
        onLoadedRangeChange: defaultCallsReturn.onLoadedRangeChange,
        onVisibleRangeChange: defaultCallsReturn.onVisibleRangeChange,
      })
    );
  });

  it('renders the CallsLegend when not in historyError state', () => {
    render(<MarketChart />);

    expect(screen.getByRole('switch', { name: 'Show calls' })).toBeInTheDocument();
    expect(screen.getByText('Price score calls')).toBeInTheDocument();
  });

  it('shows describeCall text in the legend when engine returns a hoverCall', () => {
    const hoverCall = {
      t: Date.now(),
      dir: 1 as const,
      outcome: 'won' as const,
      source: 'live' as const,
      score: 32.0,
      tier: 'strong_buy' as const,
      fwd: 1.2,
    };

    vi.mocked(useTradingChartEngine).mockReturnValue({
      containerRef: { current: null },
      isLoading: false,
      historyError: false,
      handleRefresh: handleRefreshMock,
      hoverCall,
      callsHorizon: 24,
      callsCost: 0.16,
    } as unknown as ReturnType<typeof useTradingChartEngine>);

    render(<MarketChart />);

    expect(
      screen.getByText(
        'Buy call (Strong long score), live record, score 32.0: price +1.20% over 24 bars, +1.04% after 0.16% costs, won after costs'
      )
    ).toBeInTheDocument();
  });
});
