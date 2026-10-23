import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { BacktestScreen } from './BacktestScreen';
import { useUIStore } from '@/stores/uiStore';
import { useBacktest } from '@/hooks/useBacktest';
import { useStrategies, useCreateStrategy, useUpdateStrategy, useDeleteStrategy } from '@/hooks/useStrategies';
import { useBacktestResults, useDeleteBacktestResult, useSaveBacktestResult } from '@/hooks/useBacktestResults';

vi.mock('@/hooks/useBacktest', () => ({
  useBacktest: vi.fn(),
}));

vi.mock('@/hooks/useStrategies', () => ({
  useStrategies: vi.fn(),
  useCreateStrategy: vi.fn(),
  useUpdateStrategy: vi.fn(),
  useDeleteStrategy: vi.fn(),
}));

vi.mock('@/hooks/useBacktestResults', () => ({
  useBacktestResults: vi.fn(),
  useDeleteBacktestResult: vi.fn(),
  useSaveBacktestResult: vi.fn(),
}));

// Mock recharts
vi.mock('recharts', async () => {
  const original = await vi.importActual('recharts');
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

// Mock fetch for candle range
global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ count: 1000, oldest: 1704067200000, newest: 1735689600000 }),
});

describe('BacktestScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useUIStore.setState({ selectedSymbol: 'ETHUSDT' });

    vi.mocked(useBacktest).mockReturnValue({
      status: 'idle',
      progress: 0,
      barsProcessed: 0,
      totalBars: 0,
      result: null,
      error: null,
      run: vi.fn(),
      cancel: vi.fn(),
    });

    vi.mocked(useStrategies).mockReturnValue({
      data: { strategies: [] },
      isLoading: false,
    } as unknown as ReturnType<typeof useStrategies>);

    vi.mocked(useCreateStrategy).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useCreateStrategy>);

    vi.mocked(useUpdateStrategy).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateStrategy>);

    vi.mocked(useDeleteStrategy).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useDeleteStrategy>);

    vi.mocked(useBacktestResults).mockReturnValue({
      data: { results: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBacktestResults>);

    vi.mocked(useDeleteBacktestResult).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useDeleteBacktestResult>);

    vi.mocked(useSaveBacktestResult).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useSaveBacktestResult>);
  });

  it('The evidence line and chip are present', () => {
    render(<BacktestScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Backtest' })).toBeInTheDocument();

    // Check evidence line text
    expect(
      screen.getByText(
        'Rules built on the price score were measured on years of history and lost after costs. A strong result here is more likely chance or overfitting than an edge.'
      )
    ).toBeInTheDocument();

    // Check evidence chip
    expect(screen.getByText('No edge (measured)')).toBeInTheDocument();
  });

  it('the right column holds the run panel before the results; there is exactly one element with data-testid="data-status-line"', () => {
    render(<BacktestScreen />);

    const rightColumn = screen.getByTestId('right-column');
    expect(rightColumn).toBeInTheDocument();

    const runButton = screen.getByRole('button', { name: 'Run backtest' });
    const resultsHeading = screen.getByRole('heading', { level: 2, name: 'Results' });

    expect(rightColumn).toContainElement(runButton);
    expect(rightColumn).toContainElement(resultsHeading);

    expect(
      runButton.compareDocumentPosition(resultsHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    const statusLines = screen.getAllByTestId('data-status-line');
    expect(statusLines).toHaveLength(1);
  });

  it('with a run error set, opening a saved result shows the saved metrics, not the error', async () => {
    vi.mocked(useBacktest).mockReturnValue({
      status: 'idle',
      progress: 0,
      barsProcessed: 0,
      totalBars: 0,
      result: null,
      error: 'Engine crashed during live run',
      run: vi.fn(),
      cancel: vi.fn(),
    });

    const mockSavedSummary = {
      _id: 'save-123',
      userId: 'user-1',
      strategyId: null,
      symbol: 'SOLUSDT',
      interval: '1h',
      totalBars: 1000,
      startTime: 1704067200000,
      endTime: 1707696000000,
      createdAt: '2026-01-15T00:00:00.000Z',
      metrics: {
        totalPnl: 450.0,
        totalPnlPercent: 4.5,
        totalTrades: 15,
        winningTrades: 9,
        losingTrades: 6,
        winRate: 0.6,
        profitFactor: 1.5,
        maxDrawdown: 120.0,
        maxDrawdownPercent: 1.2,
        sharpeRatio: 1.25,
        sortinoRatio: 1.6,
        calmarRatio: 3.0,
        avgWin: 60.0,
        avgLoss: 30.0,
        avgWinPercent: 0.6,
        avgLossPercent: 0.3,
        totalFees: 12.5,
        maxConsecutiveWins: 3,
        maxConsecutiveLosses: 2,
        expectancyPercent: 0.3,
        expectancyR: 0.25,
      },
    };

    vi.mocked(useBacktestResults).mockReturnValue({
      data: { results: [mockSavedSummary] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBacktestResults>);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/backtests/save-123') {
        return {
          ok: true,
          json: async () => ({
            result: {
              symbol: 'SOLUSDT',
              interval: '1h',
              config: {},
              startTime: 1704067200000,
              endTime: 1707696000000,
              totalBars: 1000,
              warmupBars: 100,
              metrics: mockSavedSummary.metrics,
              equityCurve: [{ bar: 0, time: 1704067200000, equity: 10000, drawdown: 0 }],
              trades: [],
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ count: 1000, oldest: 1704067200000, newest: 1735689600000 }),
      };
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');
    render(<BacktestScreen />);

    // Initially, the run error is displayed
    expect(screen.getByText(/Engine crashed during live run/)).toBeInTheDocument();

    // Click "View metrics" on saved result
    const viewMetricsBtn = screen.getByRole('button', { name: 'View metrics' });
    fireEvent.click(viewMetricsBtn);

    // After opening saved result, the error is gone and saved metrics are shown
    await waitFor(() => {
      expect(screen.queryByText(/Engine crashed during live run/)).not.toBeInTheDocument();
      expect(screen.getByTestId('metric-total-pnl')).toHaveTextContent('+$450.00 (+4.50%)');
      expect(screen.getByText('Saved result')).toBeInTheDocument();
    });

    global.fetch = originalFetch;
  });

  it('No text matches /guaranteed|profitable strategy|recommend/i', () => {
    const { container } = render(<BacktestScreen />);
    const pageText = container.textContent || '';
    expect(pageText).not.toMatch(/guaranteed|profitable strategy|recommend/i);
  });
});
