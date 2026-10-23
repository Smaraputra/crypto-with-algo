import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { RunPanel } from './RunPanel';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtest/types';
import { loadBacktestInputs } from '@/lib/backtest/load-inputs';

vi.mock('@/lib/backtest/load-inputs', () => ({
  loadBacktestInputs: vi.fn(),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('RunPanel', () => {
  const mockOnRun = vi.fn();
  const mockOnCancel = vi.fn();
  const mockOnDataRefreshed = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        count: 2000,
        oldest: 1704067200000,
        newest: 1735689600000,
      }),
    });
  });

  it('Run calls the loader and then run with its outputs', async () => {
    const mockKlines = [{ timestamp: 1000, open: 10, high: 20, low: 5, close: 15, volume: 100 }];
    const mockNotices = ['Higher-timeframe data unavailable; running without MTF confluence.'];

    vi.mocked(loadBacktestInputs).mockResolvedValueOnce({
      ok: true,
      klines: mockKlines,
      snapshots: undefined,
      htfInput: undefined,
      notices: mockNotices,
    });

    render(
      <RunPanel
        symbol="BTCUSDT"
        interval="1h"
        dataRange="6m"
        config={DEFAULT_BACKTEST_CONFIG}
        status="idle"
        progress={0}
        barsProcessed={0}
        totalBars={0}
        onRun={mockOnRun}
        onCancel={mockOnCancel}
        onDataRefreshed={mockOnDataRefreshed}
      />
    );

    const runBtn = screen.getByRole('button', { name: 'Run backtest' });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(loadBacktestInputs).toHaveBeenCalledWith({
        symbol: 'BTCUSDT',
        interval: '1h',
        dataRange: '6m',
      });
      expect(mockOnRun).toHaveBeenCalledWith(
        mockKlines,
        DEFAULT_BACKTEST_CONFIG,
        'BTCUSDT',
        '1h',
        undefined,
        undefined
      );
    });

    // Check loader notices rendered inline
    expect(
      screen.getByText('Higher-timeframe data unavailable; running without MTF confluence.')
    ).toBeInTheDocument();
  });

  it('The insufficient result shows the download offer, and the download POSTs the right body', async () => {
    vi.mocked(loadBacktestInputs).mockResolvedValueOnce({
      ok: false,
      reason: 'insufficient',
      bars: 50,
      message: 'Insufficient candle data (50 bars). Try downloading history first.',
    });

    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/candles/backfill') {
        const body = JSON.parse((opts?.body as string) || '{}');
        return {
          ok: true,
          json: async () => ({
            inserted: 1500,
            total: 2000,
            symbol: body.symbol,
            interval: body.interval,
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ count: 50, oldest: 1000, newest: 2000 }),
      };
    });

    render(
      <RunPanel
        symbol="ETHUSDT"
        interval="4h"
        dataRange="1y"
        config={DEFAULT_BACKTEST_CONFIG}
        status="idle"
        progress={0}
        barsProcessed={0}
        totalBars={0}
        onRun={mockOnRun}
        onCancel={mockOnCancel}
        onDataRefreshed={mockOnDataRefreshed}
      />
    );

    const runBtn = screen.getByRole('button', { name: 'Run backtest' });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(
        screen.getByText('Insufficient candle data (50 bars). Try downloading history first.')
      ).toBeInTheDocument();
    });

    // The download offer should be visible
    const downloadBtns = screen.getAllByRole('button', {
      name: 'Download 24 months of history',
    });
    expect(downloadBtns.length).toBeGreaterThanOrEqual(1);

    // Click download
    fireEvent.click(downloadBtns[downloadBtns.length - 1]);

    await waitFor(() => {
      const backfillCalls = mockFetch.mock.calls.filter(
        (call) => call[0] === '/api/candles/backfill'
      );
      expect(backfillCalls.length).toBe(1);
      const requestBody = JSON.parse(backfillCalls[0][1].body);
      expect(requestBody).toEqual({
        symbol: 'ETHUSDT',
        interval: '4h',
        months: 24,
      });
      expect(screen.getByText('Loaded 1500 new bars (2000 stored)')).toBeInTheDocument();
      expect(mockOnDataRefreshed).toHaveBeenCalled();
    });
  });

  it('Progress and Stop work', () => {
    const { rerender } = render(
      <RunPanel
        symbol="BTCUSDT"
        interval="1h"
        dataRange="6m"
        config={DEFAULT_BACKTEST_CONFIG}
        status="running"
        progress={45}
        barsProcessed={450}
        totalBars={1000}
        onRun={mockOnRun}
        onCancel={mockOnCancel}
        onDataRefreshed={mockOnDataRefreshed}
      />
    );

    const progressBar = screen.getByRole('progressbar');
    expect(progressBar).toHaveAttribute('aria-valuenow', '45');
    expect(screen.getByText('Processed 450 of 1000 bars')).toBeInTheDocument();

    const progressFill = progressBar.firstElementChild;
    expect(progressFill).not.toHaveClass('bg-brand');
    expect(progressFill).toHaveClass('bg-foreground');

    const stopBtn = screen.getByRole('button', { name: 'Stop' });
    fireEvent.click(stopBtn);
    expect(mockOnCancel).toHaveBeenCalledTimes(1);

    // Update progress
    rerender(
      <RunPanel
        symbol="BTCUSDT"
        interval="1h"
        dataRange="6m"
        config={DEFAULT_BACKTEST_CONFIG}
        status="running"
        progress={80}
        barsProcessed={800}
        totalBars={1000}
        onRun={mockOnRun}
        onCancel={mockOnCancel}
        onDataRefreshed={mockOnDataRefreshed}
      />
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80');
    expect(screen.getByText('Processed 800 of 1000 bars')).toBeInTheDocument();
  });

  it('changing symbol clears an insufficient message', async () => {
    vi.mocked(loadBacktestInputs).mockResolvedValueOnce({
      ok: false,
      reason: 'insufficient',
      bars: 50,
      message: 'Insufficient candle data (50 bars). Try downloading history first.',
    });

    const { rerender } = render(
      <RunPanel
        symbol="ETHUSDT"
        interval="1h"
        dataRange="6m"
        config={DEFAULT_BACKTEST_CONFIG}
        status="idle"
        progress={0}
        barsProcessed={0}
        totalBars={0}
        onRun={mockOnRun}
        onCancel={mockOnCancel}
        onDataRefreshed={mockOnDataRefreshed}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));

    await waitFor(() => {
      expect(
        screen.getByText('Insufficient candle data (50 bars). Try downloading history first.')
      ).toBeInTheDocument();
    });

    // Change symbol to SOLUSDT
    rerender(
      <RunPanel
        symbol="SOLUSDT"
        interval="1h"
        dataRange="6m"
        config={DEFAULT_BACKTEST_CONFIG}
        status="idle"
        progress={0}
        barsProcessed={0}
        totalBars={0}
        onRun={mockOnRun}
        onCancel={mockOnCancel}
        onDataRefreshed={mockOnDataRefreshed}
      />
    );

    await waitFor(() => {
      expect(
        screen.queryByText('Insufficient candle data (50 bars). Try downloading history first.')
      ).not.toBeInTheDocument();
    });
  });

  it('the bar count renders as 43,695', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        count: 43695,
        oldest: 1704067200000,
        newest: 1735689600000,
      }),
    });

    render(
      <RunPanel
        symbol="BTCUSDT"
        interval="1h"
        dataRange="6m"
        config={DEFAULT_BACKTEST_CONFIG}
        status="idle"
        progress={0}
        barsProcessed={0}
        totalBars={0}
        onRun={mockOnRun}
        onCancel={mockOnCancel}
        onDataRefreshed={mockOnDataRefreshed}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('data-status-line')).toHaveTextContent('43,695');
    });
  });
});
