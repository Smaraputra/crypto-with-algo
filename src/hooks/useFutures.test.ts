import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import { useFundingRate, useOpenInterest, useLongShortRatio } from './useFutures';

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

describe('useFundingRate', () => {
  it('fetches funding rate with correct query key', async () => {
    mockFetch({ fundingRates: [] });

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useFundingRate('BTCUSDT'), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual(['futures', 'funding', 'BTCUSDT', 1]);
  });

  it('fetches from correct URL', async () => {
    const fetchSpy = mockFetch({ fundingRates: [] });

    const { wrapper } = createWrapper();
    renderHook(() => useFundingRate('BTCUSDT', 5), { wrapper });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/futures/funding?symbol=BTCUSDT&limit=5',
        undefined
      );
    });
  });

  it('does not fetch when symbol is null', () => {
    const fetchSpy = mockFetch({});

    const { wrapper } = createWrapper();
    renderHook(() => useFundingRate(null), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns funding rate data', async () => {
    mockFetch({
      fundingRates: [{ symbol: 'BTCUSDT', fundingRate: 0.0001, fundingTime: 0, markPrice: 43000 }],
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useFundingRate('BTCUSDT'), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.fundingRates).toHaveLength(1);
    });
  });
});

describe('useOpenInterest', () => {
  it('fetches OI with correct query key', async () => {
    mockFetch({ openInterest: { symbol: 'BTCUSDT', openInterest: 12345, time: 0 }, history: null });

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useOpenInterest('BTCUSDT'), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual(['futures', 'oi', 'BTCUSDT', false]);
  });

  it('includes history flag in URL', async () => {
    const fetchSpy = mockFetch({ openInterest: {}, history: [] });

    const { wrapper } = createWrapper();
    renderHook(() => useOpenInterest('BTCUSDT', true), { wrapper });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/futures/open-interest?symbol=BTCUSDT&history=true',
        undefined
      );
    });
  });

  it('does not fetch when symbol is null', () => {
    const fetchSpy = mockFetch({});

    const { wrapper } = createWrapper();
    renderHook(() => useOpenInterest(null), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('useLongShortRatio', () => {
  it('fetches L/S ratio with correct query key', async () => {
    mockFetch({ longShortRatio: [] });

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useLongShortRatio('BTCUSDT', '4h', 'global'), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual(['futures', 'ls', 'BTCUSDT', '4h', 'global']);
  });

  it('fetches from correct URL', async () => {
    const fetchSpy = mockFetch({ longShortRatio: [] });

    const { wrapper } = createWrapper();
    renderHook(() => useLongShortRatio('BTCUSDT', '1h', 'top'), { wrapper });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/futures/long-short?symbol=BTCUSDT&period=1h&type=top',
        undefined
      );
    });
  });

  it('does not fetch when symbol is null', () => {
    const fetchSpy = mockFetch({});

    const { wrapper } = createWrapper();
    renderHook(() => useLongShortRatio(null), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns L/S ratio data', async () => {
    mockFetch({
      longShortRatio: [{ symbol: 'BTCUSDT', longShortRatio: 1.23, longAccount: 0.55, shortAccount: 0.45, timestamp: 0 }],
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useLongShortRatio('BTCUSDT'), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.longShortRatio).toHaveLength(1);
    });
  });

  it('handles error response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Failed' }), { status: 502 })
    );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useLongShortRatio('BTCUSDT'), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
