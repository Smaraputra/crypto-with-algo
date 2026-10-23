import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoinChart } from './CoinChart';

const mockUseTradingChartEngine = vi.fn();

vi.mock('@/components/chart/useTradingChartEngine', async () => {
  const actual = await vi.importActual<typeof import('@/components/chart/useTradingChartEngine')>(
    '@/components/chart/useTradingChartEngine'
  );
  return {
    ...actual,
    useTradingChartEngine: (options: unknown) => mockUseTradingChartEngine(options),
  };
});

vi.mock('@/hooks/useFocusMtf', () => ({
  useFocusMtf: () => ({
    data: {
      priorDay: { high: 70000, low: 68000, close: 69000 },
    },
  }),
}));

vi.mock('@/hooks/useSignalLabV4', () => ({
  useSignalLabV4: () => ({
    data: {
      hypotheses: [],
    },
  }),
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTradingChartEngine.mockReturnValue(defaultEngineReturn);
  });

  const getLastCall = () => {
    const calls = mockUseTradingChartEngine.mock.calls;
    return calls[calls.length - 1][0];
  };

  it('passes initialIndicators as [] and maps default 1h interval', () => {
    render(<CoinChart symbol="BTCUSDT" />);

    expect(mockUseTradingChartEngine).toHaveBeenCalled();
    const lastCall = getLastCall();
    expect(lastCall.initialIndicators).toEqual([]);
    expect(lastCall.interval).toBe('1h');
    expect(lastCall.market).toBe('perp');
    expect(lastCall.showCandleTooltip).toBe(false);
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
    const tryAgainBtn = screen.getByRole('button', { name: 'Try again' });
    await user.click(tryAgainBtn);

    expect(handleRefresh).toHaveBeenCalledTimes(1);
  });
});
