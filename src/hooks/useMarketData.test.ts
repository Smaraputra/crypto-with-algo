import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { mockOHLCV } from '@/__fixtures__/binance';
import { useMarketData } from './useMarketData';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('useMarketData', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches with correct URL params', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockOHLCV), { status: 200 })
    );

    renderHook(() => useMarketData('BTCUSDT', '1h', 100), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('/api/prices/history');
    expect(url).toContain('symbol=BTCUSDT');
    expect(url).toContain('interval=1h');
    expect(url).toContain('limit=100');
  });

  it('returns OHLCV data on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockOHLCV), { status: 200 })
    );

    const { result } = renderHook(() => useMarketData('BTCUSDT', '1h'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockOHLCV);
    expect(result.current.data).toHaveLength(3);
    expect(result.current.data![0].timestamp).toBe(1700000000000);
  });

  it('handles fetch error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Failed' }), { status: 500 })
    );

    const { result } = renderHook(() => useMarketData('BTCUSDT', '1h'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error!.message).toBe('Failed to fetch market data');
  });

  it('is disabled when symbol is empty', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 })
    );

    const { result } = renderHook(() => useMarketData('', '1h'), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses default limit of 500', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockOHLCV), { status: 200 })
    );

    renderHook(() => useMarketData('BTCUSDT', '1h'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('limit=500');
  });

  it('query key includes all params', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 })
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);

    renderHook(() => useMarketData('BTCUSDT', '4h', 200), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache).toHaveLength(1);
    expect(cache[0].queryKey).toEqual(['ohlcv', 'BTCUSDT', '4h', 200]);
  });

  it('different intervals produce different cache entries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockOHLCV), { status: 200 })
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);

    const { rerender } = renderHook(
      ({ interval }: { interval: string }) => useMarketData('BTCUSDT', interval),
      { wrapper, initialProps: { interval: '1h' } }
    );

    await waitFor(() => {
      const entries = queryClient.getQueryCache().findAll();
      expect(entries.some((e) => e.state.status === 'success')).toBe(true);
    });

    rerender({ interval: '4h' });

    await waitFor(() => {
      const entries = queryClient.getQueryCache().findAll();
      expect(entries).toHaveLength(2);
    });

    const keys = queryClient.getQueryCache().findAll().map((e) => e.queryKey);
    expect(keys).toContainEqual(['ohlcv', 'BTCUSDT', '1h', 500]);
    expect(keys).toContainEqual(['ohlcv', 'BTCUSDT', '4h', 500]);
  });
});
