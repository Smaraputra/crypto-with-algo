import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import { useSignals, useLatestSignal, useComputeSignal } from './useSignals';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return {
    wrapper: function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(QueryClientProvider, { client: queryClient }, children);
    },
    queryClient,
  };
}

function mockFetch(data: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(data), { status })
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useSignals', () => {
  it('fetches signals with correct query key', async () => {
    mockFetch({ signals: [] });

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useSignals('BTCUSDT', 'buy', 20), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual(['signals', 'BTCUSDT', 'buy', 20]);
  });

  it('fetches from correct URL', async () => {
    const fetchSpy = mockFetch({ signals: [] });

    const { wrapper } = createWrapper();
    renderHook(() => useSignals('BTCUSDT'), { wrapper });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/signals?'),
        undefined
      );
    });
  });

  it('returns signal data', async () => {
    const mockSignals = {
      signals: [
        { _id: 's1', symbol: 'BTCUSDT', score: 45, tier: 'buy' },
      ],
    };
    mockFetch(mockSignals);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSignals('BTCUSDT'), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.signals).toHaveLength(1);
    });
  });

  it('handles null symbol', async () => {
    mockFetch({ signals: [] });

    const { wrapper } = createWrapper();
    renderHook(() => useSignals(null), { wrapper });

    // Should still fetch (no enabled guard for list)
    const { wrapper: w2, queryClient } = createWrapper();
    renderHook(() => useSignals(null), { wrapper: w2 });
    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual(['signals', null, undefined, 50]);
  });
});

describe('useLatestSignal', () => {
  it('fetches latest signal for symbol', async () => {
    const fetchSpy = mockFetch({ signals: [{ _id: 's1', score: 50 }] });

    const { wrapper } = createWrapper();
    renderHook(() => useLatestSignal('BTCUSDT'), { wrapper });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/signals?symbol=BTCUSDT&limit=1',
        undefined
      );
    });
  });

  it('does not fetch when symbol is null', () => {
    const fetchSpy = mockFetch({});

    const { wrapper } = createWrapper();
    renderHook(() => useLatestSignal(null), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns data on success', async () => {
    mockFetch({ signals: [{ _id: 's1', score: 72, tier: 'strong_buy' }] });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useLatestSignal('BTCUSDT'), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.signals[0].score).toBe(72);
    });
  });
});

describe('useComputeSignal', () => {
  it('returns a mutation', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useComputeSignal(), { wrapper });

    expect(result.current.mutate).toBeDefined();
    expect(result.current.isPending).toBe(false);
  });

  it('calls POST with correct body', async () => {
    const fetchSpy = mockFetch({
      signal: { _id: 's1', symbol: 'BTCUSDT', score: 40, tier: 'buy' },
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useComputeSignal(), { wrapper });

    result.current.mutate({ symbol: 'BTCUSDT', interval: '4h' });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/signals/compute',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ symbol: 'BTCUSDT', interval: '4h' }),
        })
      );
    });
  });

  it('handles error response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Failed' }), { status: 500 })
    );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useComputeSignal(), { wrapper });

    result.current.mutate({ symbol: 'BTCUSDT' });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
