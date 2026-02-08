import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { mockTickers } from '@/__fixtures__/binance';
import { useTickers } from './usePrices';

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

describe('useTickers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches from /api/prices on mount', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockTickers), { status: 200 })
    );

    renderHook(() => useTickers(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/prices');
    });
  });

  it('returns ticker data on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockTickers), { status: 200 })
    );

    const { result } = renderHook(() => useTickers(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockTickers);
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0].symbol).toBe('BTCUSDT');
  });

  it('handles fetch error (non-OK response)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Failed' }), { status: 500 })
    );

    const { result } = renderHook(() => useTickers(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error!.message).toBe('Failed to fetch tickers');
  });

  it('uses query key ["tickers"]', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 })
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);

    renderHook(() => useTickers(), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache).toHaveLength(1);
    expect(cache[0].queryKey).toEqual(['tickers']);
  });

  it('sets refetchInterval to 30s', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockTickers), { status: 200 })
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);

    renderHook(() => useTickers(), { wrapper });

    await waitFor(() => {
      const query = queryClient.getQueryCache().findAll()[0];
      expect(query).toBeDefined();
    });

    const query = queryClient.getQueryCache().findAll()[0];
    expect((query.options as { refetchInterval?: number }).refetchInterval).toBe(30_000);
  });
});
