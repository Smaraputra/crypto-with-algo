import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import {
  usePortfolioHistory,
  useCostBasis,
  useRiskMetrics,
} from './useAnalytics';

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

describe('usePortfolioHistory', () => {
  it('fetches history with correct query key', async () => {
    mockFetch({ history: [] });

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => usePortfolioHistory('p1', 30), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual(['analytics', 'history', 'p1', 30]);
  });

  it('fetches from correct URL', async () => {
    const fetchSpy = mockFetch({ history: [] });

    const { wrapper } = createWrapper();
    renderHook(() => usePortfolioHistory('p1', 30), { wrapper });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/analytics/history?portfolioId=p1&range=30',
        undefined
      );
    });
  });

  it('returns history data', async () => {
    const mockHistory = {
      history: [
        { date: '2024-01-15', totalValue: 26000, totalCost: 25000, unrealizedPnl: 1000, unrealizedPnlPercent: 4 },
      ],
    };
    mockFetch(mockHistory);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePortfolioHistory('p1'), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.history).toHaveLength(1);
    });
  });

  it('does not fetch when portfolioId is null', () => {
    const fetchSpy = mockFetch({});

    const { wrapper } = createWrapper();
    renderHook(() => usePortfolioHistory(null), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('defaults range to 30', () => {
    mockFetch({ history: [] });

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => usePortfolioHistory('p1'), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual(['analytics', 'history', 'p1', 30]);
  });
});

describe('useCostBasis', () => {
  it('fetches cost basis with correct query key', async () => {
    mockFetch({ costBasis: { holdings: [], totalRealizedGain: 0, totalUnrealizedCostBasis: 0 } });

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useCostBasis('p1'), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual(['analytics', 'cost-basis', 'p1']);
  });

  it('fetches from correct URL', async () => {
    const fetchSpy = mockFetch({ costBasis: {} });

    const { wrapper } = createWrapper();
    renderHook(() => useCostBasis('p1'), { wrapper });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/analytics/cost-basis?portfolioId=p1',
        undefined
      );
    });
  });

  it('does not fetch when portfolioId is null', () => {
    const fetchSpy = mockFetch({});

    const { wrapper } = createWrapper();
    renderHook(() => useCostBasis(null), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns cost basis data', async () => {
    const mockData = {
      costBasis: {
        holdings: [{ symbol: 'BTCUSDT', totalQuantity: 0.5 }],
        totalRealizedGain: 5000,
        totalUnrealizedCostBasis: 20000,
      },
    };
    mockFetch(mockData);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCostBasis('p1'), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.costBasis.holdings).toHaveLength(1);
      expect(result.current.data?.costBasis.totalRealizedGain).toBe(5000);
    });
  });
});

describe('useRiskMetrics', () => {
  it('fetches metrics with correct query key', async () => {
    mockFetch({ metrics: null, insufficientData: true, dataPoints: 0, minRequired: 30 });

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useRiskMetrics('p1', 90), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual(['analytics', 'metrics', 'p1', 90]);
  });

  it('fetches from correct URL', async () => {
    const fetchSpy = mockFetch({ metrics: null });

    const { wrapper } = createWrapper();
    renderHook(() => useRiskMetrics('p1', 90), { wrapper });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/analytics/metrics?portfolioId=p1&range=90',
        undefined
      );
    });
  });

  it('does not fetch when portfolioId is null', () => {
    const fetchSpy = mockFetch({});

    const { wrapper } = createWrapper();
    renderHook(() => useRiskMetrics(null), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('defaults range to 90', () => {
    mockFetch({ metrics: null });

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useRiskMetrics('p1'), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual(['analytics', 'metrics', 'p1', 90]);
  });

  it('handles error response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRiskMetrics('p1'), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
