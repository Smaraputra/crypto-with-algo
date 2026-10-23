import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketChart } from './MarketChart';
import { useTradingChartEngine } from '@/components/chart/useTradingChartEngine';
import { useUIStore } from '@/stores/uiStore';

vi.mock('@/components/chart/useTradingChartEngine', () => ({
  useTradingChartEngine: vi.fn(),
}));

describe('MarketChart', () => {
  const handleRefreshMock = vi.fn();
  const setSelectedIntervalMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({
      selectedSymbol: 'BTCUSDT',
      selectedInterval: '1h',
      setSelectedInterval: setSelectedIntervalMock,
    });

    vi.mocked(useTradingChartEngine).mockReturnValue({
      containerRef: { current: null },
      isLoading: false,
      historyError: false,
      handleRefresh: handleRefreshMock,
    } as unknown as ReturnType<typeof useTradingChartEngine>);
  });

  it('renders loading status when engine is loading', () => {
    vi.mocked(useTradingChartEngine).mockReturnValue({
      containerRef: { current: null },
      isLoading: true,
      historyError: false,
      handleRefresh: handleRefreshMock,
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
    } as unknown as ReturnType<typeof useTradingChartEngine>);

    render(<MarketChart />);

    expect(screen.getByText('The chart did not load.')).toBeInTheDocument();
    expect(
      screen.getByText('Price history did not answer. Try again in a minute.')
    ).toBeInTheDocument();

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

  it('passes initialIndicators: [], showCandleTooltip: false, and restoreOverlays: false to useTradingChartEngine', () => {
    render(<MarketChart />);

    expect(useTradingChartEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        initialIndicators: [],
        showCandleTooltip: false,
        restoreOverlays: false,
      })
    );
  });
});
