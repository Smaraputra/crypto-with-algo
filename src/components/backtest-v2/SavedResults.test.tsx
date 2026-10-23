import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { SavedResults } from './SavedResults';
import { useBacktestResults, useDeleteBacktestResult } from '@/hooks/useBacktestResults';
import type { BacktestResultSummary } from '@/types/backtest';

vi.mock('@/hooks/useBacktestResults', () => ({
  useBacktestResults: vi.fn(),
  useDeleteBacktestResult: vi.fn(),
}));

const mockSummaryFixture: BacktestResultSummary = {
  _id: 'save-123',
  userId: 'user-1',
  strategyId: 'strat-1',
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

describe('SavedResults', () => {
  const mockMutateDelete = vi.fn();
  const mockOnSelectResult = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useDeleteBacktestResult).mockReturnValue({
      mutateAsync: mockMutateDelete,
      isPending: false,
    } as unknown as ReturnType<typeof useDeleteBacktestResult>);
  });

  it('renders the list with key metrics and date', () => {
    vi.mocked(useBacktestResults).mockReturnValue({
      data: { results: [mockSummaryFixture] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useBacktestResults>);

    render(<SavedResults onSelectResult={mockOnSelectResult} />);

    expect(screen.getByText('SOLUSDT 1h')).toBeInTheDocument();
    expect(screen.getByText('Jan 15, 2026')).toBeInTheDocument();
    expect(screen.getByText('+$450.00 (+4.50%)')).toBeInTheDocument();
    expect(screen.getByText('60.0%')).toBeInTheDocument();
    expect(screen.getByText('1.25')).toBeInTheDocument();
  });

  it('opening one shows its metrics', () => {
    vi.mocked(useBacktestResults).mockReturnValue({
      data: { results: [mockSummaryFixture] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useBacktestResults>);

    render(<SavedResults onSelectResult={mockOnSelectResult} />);

    expect(screen.queryByTestId('expanded-metrics-save-123')).not.toBeInTheDocument();

    const viewMetricsBtn = screen.getByRole('button', { name: 'View metrics' });
    fireEvent.click(viewMetricsBtn);

    expect(screen.getByTestId('expanded-metrics-save-123')).toBeInTheDocument();
    expect(screen.getByText('1.50')).toBeInTheDocument(); // Profit factor
    expect(screen.getByText('1.2%')).toBeInTheDocument(); // Max drawdown
    expect(screen.getByText('+0.30%')).toBeInTheDocument(); // Expectancy
    expect(screen.getByText('$12.50')).toBeInTheDocument(); // Total fees
  });

  it('deleting asks for confirmation then calls mutation', async () => {
    vi.mocked(useBacktestResults).mockReturnValue({
      data: { results: [mockSummaryFixture] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useBacktestResults>);

    render(<SavedResults onSelectResult={mockOnSelectResult} />);

    const deleteBtn = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(deleteBtn);

    expect(screen.getByText('Confirm?')).toBeInTheDocument();
    expect(mockMutateDelete).not.toHaveBeenCalled();

    // Now click the confirmed Delete button
    const confirmDeleteBtn = screen.getAllByRole('button', { name: 'Delete' })[0];
    fireEvent.click(confirmDeleteBtn);

    await waitFor(() => {
      expect(mockMutateDelete).toHaveBeenCalledWith('save-123');
    });
  });

  it('a failed detail fetch shows "This saved run did not load."', async () => {
    vi.mocked(useBacktestResults).mockReturnValue({
      data: { results: [mockSummaryFixture] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useBacktestResults>);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    render(<SavedResults onSelectResult={mockOnSelectResult} />);

    const viewMetricsBtn = screen.getByRole('button', { name: 'View metrics' });
    fireEvent.click(viewMetricsBtn);

    await waitFor(() => {
      expect(screen.getByText('This saved run did not load.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    global.fetch = originalFetch;
  });
});
