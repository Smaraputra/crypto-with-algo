import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

import { useWatchlist } from './useWatchlist';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return {
    wrapper: function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(QueryClientProvider, { client: queryClient }, children);
    },
    queryClient,
  };
}

describe('useWatchlist', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches from /api/watchlist on mount', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ symbols: ['BTCUSDT'] }), { status: 200 })
    );

    const { wrapper } = createWrapper();
    renderHook(() => useWatchlist(), { wrapper });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/watchlist');
    });
  });

  it('returns symbols on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ symbols: ['BTCUSDT', 'ETHUSDT'] }), { status: 200 })
    );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useWatchlist(), { wrapper });

    await waitFor(() => {
      expect(result.current.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
    });
  });

  it('returns empty array while loading', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useWatchlist(), { wrapper });

    expect(result.current.symbols).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it('handles fetch error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useWatchlist(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.symbols).toEqual([]);
  });

  it('uses query key ["watchlist"]', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ symbols: [] }), { status: 200 })
    );

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useWatchlist(), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache).toHaveLength(1);
    expect(cache[0].queryKey).toEqual(['watchlist']);
  });

  it('addSymbol sends PUT with appended symbol', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ symbols: ['BTCUSDT'] }), { status: 200 })
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ symbols: ['BTCUSDT', 'ETHUSDT'] }), { status: 200 })
      );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useWatchlist(), { wrapper });

    await waitFor(() => {
      expect(result.current.symbols).toEqual(['BTCUSDT']);
    });

    act(() => {
      result.current.addSymbol('ETHUSDT');
    });

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (call) => typeof call[1] === 'object' && call[1]?.method === 'PUT'
      );
      expect(putCall).toBeDefined();
      expect(putCall![0]).toBe('/api/watchlist');
      expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
        symbols: ['BTCUSDT', 'ETHUSDT'],
      });
    });
  });

  it('addSymbol skips duplicate', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ symbols: ['BTCUSDT'] }), { status: 200 })
    );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useWatchlist(), { wrapper });

    await waitFor(() => {
      expect(result.current.symbols).toEqual(['BTCUSDT']);
    });

    act(() => {
      result.current.addSymbol('BTCUSDT');
    });

    // Only the initial GET call should have been made, no PUT
    const putCalls = fetchSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' && call[1]?.method === 'PUT'
    );
    expect(putCalls).toHaveLength(0);
  });

  it('removeSymbol sends PUT with filtered array', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ symbols: ['BTCUSDT', 'ETHUSDT'] }), { status: 200 })
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ symbols: ['ETHUSDT'] }), { status: 200 })
      );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useWatchlist(), { wrapper });

    await waitFor(() => {
      expect(result.current.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
    });

    act(() => {
      result.current.removeSymbol('BTCUSDT');
    });

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (call) => typeof call[1] === 'object' && call[1]?.method === 'PUT'
      );
      expect(putCall).toBeDefined();
      expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
        symbols: ['ETHUSDT'],
      });
    });
  });

  it('optimistic update: query data updates before fetch resolves', async () => {
    let resolvePut: ((value: Response) => void) | undefined;

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ symbols: ['BTCUSDT'] }), { status: 200 })
      )
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => { resolvePut = resolve; })
      );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useWatchlist(), { wrapper });

    await waitFor(() => {
      expect(result.current.symbols).toEqual(['BTCUSDT']);
    });

    act(() => {
      result.current.addSymbol('ETHUSDT');
    });

    // Optimistic update should show new symbol before PUT resolves
    await waitFor(() => {
      expect(result.current.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
    });

    // Resolve the PUT
    act(() => {
      resolvePut?.(new Response(JSON.stringify({ symbols: ['BTCUSDT', 'ETHUSDT'] }), { status: 200 }));
    });
  });

  it('shows toast error on mutation failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ symbols: ['BTCUSDT'] }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Failed' }), { status: 500 })
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ symbols: ['BTCUSDT'] }), { status: 200 })
      );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useWatchlist(), { wrapper });

    await waitFor(() => {
      expect(result.current.symbols).toEqual(['BTCUSDT']);
    });

    act(() => {
      result.current.addSymbol('ETHUSDT');
    });

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to update watchlist');
    });
  });

  it('optimistic rollback: data reverts on mutation error', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ symbols: ['BTCUSDT'] }), { status: 200 })
      )
      .mockResolvedValueOnce(
        // PUT fails
        new Response(JSON.stringify({ error: 'Failed' }), { status: 500 })
      )
      .mockResolvedValue(
        // Invalidation refetch returns original
        new Response(JSON.stringify({ symbols: ['BTCUSDT'] }), { status: 200 })
      );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useWatchlist(), { wrapper });

    await waitFor(() => {
      expect(result.current.symbols).toEqual(['BTCUSDT']);
    });

    act(() => {
      result.current.addSymbol('ETHUSDT');
    });

    // After error + rollback + refetch, symbols should revert
    await waitFor(() => {
      expect(result.current.symbols).toEqual(['BTCUSDT']);
    });
  });
});
