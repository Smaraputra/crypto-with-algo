import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/fetch-json', () => ({
  fetchJson: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { fetchJson } from '@/lib/fetch-json';
import { toast } from 'sonner';
import {
  useBacktestResults,
  useBacktestResultDetail,
  useSaveBacktestResult,
  useDeleteBacktestResult,
} from './useBacktestResults';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useBacktestResults', () => {
  it('fetches results list', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ results: [{ _id: 'bt1' }] });
    const { result } = renderHook(() => useBacktestResults(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/backtests');
  });
});

describe('useBacktestResultDetail', () => {
  it('fetches detail when id provided', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ result: { _id: 'bt1' } });
    const { result } = renderHook(() => useBacktestResultDetail('bt1'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/backtests/bt1');
  });

  it('does not fetch when id is null', () => {
    renderHook(() => useBacktestResultDetail(null), {
      wrapper: createWrapper(),
    });
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

describe('useSaveBacktestResult', () => {
  it('saves and shows success toast', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ result: { _id: 'bt1' } });
    const { result } = renderHook(() => useSaveBacktestResult(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      symbol: 'BTCUSDT',
      interval: '1h',
      config: {},
      metrics: {},
      trades: [],
      equityCurve: [],
      totalBars: 500,
      warmupBars: 200,
      startTime: 1704067200000,
      endTime: 1704153600000,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.success).toHaveBeenCalledWith('Backtest result saved');
  });
});

describe('useDeleteBacktestResult', () => {
  it('deletes and shows success toast', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ success: true });
    const { result } = renderHook(() => useDeleteBacktestResult(), {
      wrapper: createWrapper(),
    });

    result.current.mutate('bt1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.success).toHaveBeenCalledWith('Backtest result deleted');
  });
});
