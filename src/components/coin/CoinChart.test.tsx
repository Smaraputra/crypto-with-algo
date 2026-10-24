import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoinChart } from './CoinChart';

const mockUseTradingChartEngine = vi.fn();
const mockUseChartCalls = vi.fn();

vi.mock('@/components/chart/useTradingChartEngine', async () => {
  const actual = await vi.importActual<typeof import('@/components/chart/useTradingChartEngine')>(
    '@/components/chart/useTradingChartEngine'
  );
  return {
    ...actual,
    useTradingChartEngine: (options: unknown) => mockUseTradingChartEngine(options),
  };
});

vi.mock('@/hooks/useChartCalls', () => ({
  useChartCalls: (...args: unknown[]) => mockUseChartCalls(...args),
}));

vi.mock('@/hooks/useFocusMtf', () => ({
  useFocusMtf: () => ({
    data: {
      priorDay: { high: 70000, low: 68000, close: 69000 },
    },
  }),
}));

const mockUseSignalLabV4 = vi.fn();

vi.mock('@/hooks/useSignalLabV4', () => ({
  useSignalLabV4: (...args: unknown[]) => mockUseSignalLabV4(...args),
}));

describe('CoinChart', () => {
  const defaultEngineReturn = {
    containerRef: { current: null },
    isLoading: false,
    historyError: false,
    handleRefresh: vi.fn(),
    activeDrawingTool: null,
    activateDrawingTool: vi.fn(),
    clearDrawings: vi.fn(),
    magnetMode: 'normal',
    toggleMagnetMode: vi.fn(),
    hoverCall: null,
    callsHorizon: 24,
    callsCost: 0.16,
  };

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
    mockUseSignalLabV4.mockReturnValue({ data: { hypotheses: [] } });
    mockUseChartCalls.mockReturnValue(defaultCallsReturn);
    mockUseTradingChartEngine.mockReturnValue(defaultEngineReturn);
  });

  const getLastCall = () => {
    const calls = mockUseTradingChartEngine.mock.calls;
    return calls[calls.length - 1][0];
  };

  it('passes initialIndicators as [] and maps default 1h interval and callsOverlay', () => {
    render(<CoinChart symbol="BTCUSDT" />);

    expect(mockUseTradingChartEngine).toHaveBeenCalled();
    const lastCall = getLastCall();
    expect(lastCall.initialIndicators).toEqual([]);
    expect(lastCall.interval).toBe('1h');
    expect(lastCall.market).toBe('perp');
    expect(lastCall.showCandleTooltip).toBe(false);
    expect(lastCall.callsOverlay).toBe(mockCallsOverlay);
    expect(lastCall.onLoadedRangeChange).toBe(defaultCallsReturn.onLoadedRangeChange);
    expect(lastCall.onVisibleRangeChange).toBe(defaultCallsReturn.onVisibleRangeChange);
  });

  it('maps interval control changes to the engine interval', async () => {
    const user = userEvent.setup();
    render(<CoinChart symbol="BTCUSDT" />);

    const opt4h = screen.getByLabelText('4h');
    await user.click(opt4h);

    const lastCall = getLastCall();
    expect(lastCall.interval).toBe('4h');
    expect(lastCall.focusOverlay.intervalMs).toBe(14_400_000);
  });

  it('toggles Structure, 50 SMA, and MACD setting aria-pressed and focusOverlay flags', async () => {
    const user = userEvent.setup();
    render(<CoinChart symbol="BTCUSDT" />);

    const structBtn = screen.getByRole('button', { name: 'Structure' });
    const smaBtn = screen.getByRole('button', { name: '50 SMA' });
    const macdBtn = screen.getByRole('button', { name: 'MACD' });

    expect(structBtn).toHaveAttribute('aria-pressed', 'false');
    expect(smaBtn).toHaveAttribute('aria-pressed', 'false');
    expect(macdBtn).toHaveAttribute('aria-pressed', 'false');

    let lastCall = getLastCall();
    expect(lastCall.focusOverlay.showInternal).toBe(false);
    expect(lastCall.focusOverlay.showSma).toBe(false);
    expect(lastCall.focusOverlay.showMacd).toBe(false);

    await user.click(structBtn);
    expect(structBtn).toHaveAttribute('aria-pressed', 'true');
    lastCall = getLastCall();
    expect(lastCall.focusOverlay.showInternal).toBe(true);

    await user.click(smaBtn);
    expect(smaBtn).toHaveAttribute('aria-pressed', 'true');
    lastCall = getLastCall();
    expect(lastCall.focusOverlay.showSma).toBe(true);

    await user.click(macdBtn);
    expect(macdBtn).toHaveAttribute('aria-pressed', 'true');
    lastCall = getLastCall();
    expect(lastCall.focusOverlay.showMacd).toBe(true);
  });

  it('reveals drawing tools when Draw disclosure is clicked', async () => {
    const user = userEvent.setup();
    render(<CoinChart symbol="BTCUSDT" />);

    expect(screen.queryByRole('toolbar', { name: 'Drawing tools' })).not.toBeInTheDocument();

    const drawBtn = screen.getByRole('button', { name: /draw/i });
    expect(drawBtn).toHaveAttribute('aria-expanded', 'false');

    await user.click(drawBtn);
    expect(drawBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('toolbar', { name: 'Drawing tools' })).toBeInTheDocument();

    expect(screen.getByLabelText('Trendline')).toBeInTheDocument();
    expect(screen.getByLabelText('Horizontal Line')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Magnet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear drawings' })).toBeInTheDocument();
  });

  it('shows error state when historyError is true and calls refresh on Try again', async () => {
    const user = userEvent.setup();
    const handleRefresh = vi.fn();
    mockUseTradingChartEngine.mockReturnValue({
      ...defaultEngineReturn,
      historyError: true,
      handleRefresh,
    });

    render(<CoinChart symbol="BTCUSDT" />);

    expect(screen.getByText('The chart did not load.')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Show calls' })).not.toBeInTheDocument();
    const tryAgainBtn = screen.getByRole('button', { name: 'Try again' });
    await user.click(tryAgainBtn);

    expect(handleRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders CallsLegend when not in historyError state', () => {
    render(<CoinChart symbol="BTCUSDT" />);

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

    mockUseTradingChartEngine.mockReturnValue({
      ...defaultEngineReturn,
      hoverCall,
      callsHorizon: 24,
      callsCost: 0.16,
    });

    render(<CoinChart symbol="BTCUSDT" />);

    expect(
      screen.getByText(
        'Buy call (Strong long score), live record, score 32.0: price +1.20% over 24 bars, +1.04% after 0.16% costs, won after costs'
      )
    ).toBeInTheDocument();
  });

  it('passes labMarks with outcomes won and open and renders lab legend line when marks exist', () => {
    const tWonBar = 1_700_000_000_000;
    const tOpenBar = 1_700_003_600_000;
    mockUseSignalLabV4.mockReturnValue({
      data: {
        hypotheses: [
          {
            id: 'S1-1h',
            candidate: 'S1',
            closedTrades: [
              {
                symbol: 'BTCUSDT',
                side: 1,
                enteredAt: new Date(tWonBar + 600_000).toISOString(),
                exitedAt: new Date(tWonBar + 600_000 + 8 * 3600_000).toISOString(),
                move: 0.02,
                outcome: 'won',
              },
            ],
            openTrades: [],
          },
          {
            id: 'S2-1h',
            candidate: 'S2',
            closedTrades: [],
            openTrades: [
              {
                symbol: 'BTCUSDT',
                side: -1,
                enteredAt: new Date(tOpenBar).toISOString(),
                exitsAt: new Date(tOpenBar + 8 * 3600_000).toISOString(),
              },
            ],
          },
        ],
      },
    });

    render(<CoinChart symbol="BTCUSDT" />);

    const lastCall = getLastCall();
    expect(lastCall.focusOverlay.labMarks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'won', label: 'S1' }),
        expect.objectContaining({ outcome: 'open', label: 'S2' }),
      ])
    );
    expect(
      screen.getByText(
        'Lab S1 and S2 trades: filled when the 8 hour hold ended, coloured won after 0.14% costs, right but costs ate it, or wrong way. Funding is not included. Hollow means still open.'
      )
    ).toBeInTheDocument();
  });

  it('does not render lab legend line when there are no lab marks', () => {
    mockUseSignalLabV4.mockReturnValue({
      data: {
        hypotheses: [],
      },
    });

    render(<CoinChart symbol="BTCUSDT" />);
    expect(
      screen.queryByText(/Lab S1 and S2 trades: filled when the 8 hour hold ended/)
    ).not.toBeInTheDocument();
  });
});
