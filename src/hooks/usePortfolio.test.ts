import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

const mockToast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: mockToast }));

import {
  usePortfolios,
  usePortfolio,
  useCreatePortfolio,
  useRenamePortfolio,
  useDeletePortfolio,
  useAddHolding,
  useRemoveHolding,
  useRecordTransaction,
  useTransactions,
} from './usePortfolio';

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

function mockFetch(data: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(data), { status })
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('usePortfolios', () => {
  it('fetches portfolio list', async () => {
    const data = { portfolios: [{ _id: 'p1', name: 'My Portfolio', holdingsCount: 2 }] };
    mockFetch(data);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePortfolios(), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.portfolios).toHaveLength(1);
    });
  });

  it('uses query key ["portfolios"]', () => {
    mockFetch({ portfolios: [] });

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => usePortfolios(), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual(['portfolios']);
  });
});

describe('usePortfolio', () => {
  it('fetches single portfolio by id', async () => {
    const data = {
      portfolio: { _id: 'p1', name: 'My Portfolio', holdings: [] },
    };
    mockFetch(data);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePortfolio('p1'), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.portfolio.name).toBe('My Portfolio');
    });
  });

  it('does not fetch when id is null', () => {
    const fetchSpy = mockFetch({});

    const { wrapper } = createWrapper();
    renderHook(() => usePortfolio(null), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('useCreatePortfolio', () => {
  it('sends POST to /api/portfolio', async () => {
    const fetchSpy = mockFetch({ portfolio: { _id: 'p2', name: 'Trading' } }, 201);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCreatePortfolio(), { wrapper });

    act(() => {
      result.current.mutate('Trading');
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const postCall = fetchSpy.mock.calls.find(
      (c) => typeof c[1] === 'object' && c[1]?.method === 'POST'
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({ name: 'Trading' });
  });

  it('invalidates portfolios query on settle', async () => {
    mockFetch({ portfolio: { _id: 'p2', name: 'Trading' } }, 201);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreatePortfolio(), { wrapper });

    act(() => {
      result.current.mutate('Trading');
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['portfolios'] });
    });
  });
});

describe('useRenamePortfolio', () => {
  it('sends PATCH to /api/portfolio/[id]', async () => {
    const fetchSpy = mockFetch({ portfolio: { _id: 'p1', name: 'Renamed' } });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRenamePortfolio(), { wrapper });

    act(() => {
      result.current.mutate({ id: 'p1', name: 'Renamed' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const patchCall = fetchSpy.mock.calls.find(
      (c) => typeof c[1] === 'object' && c[1]?.method === 'PATCH'
    );
    expect(patchCall![0]).toBe('/api/portfolio/p1');
  });
});

describe('useDeletePortfolio', () => {
  it('sends DELETE to /api/portfolio/[id]', async () => {
    const fetchSpy = mockFetch({ success: true });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDeletePortfolio(), { wrapper });

    act(() => {
      result.current.mutate('p1');
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const deleteCall = fetchSpy.mock.calls.find(
      (c) => typeof c[1] === 'object' && c[1]?.method === 'DELETE'
    );
    expect(deleteCall![0]).toBe('/api/portfolio/p1');
  });
});

describe('useAddHolding', () => {
  it('sends POST to holdings endpoint', async () => {
    const fetchSpy = mockFetch({ portfolio: { _id: 'p1', holdings: [] } });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAddHolding('p1'), { wrapper });

    act(() => {
      result.current.mutate({
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        type: 'buy',
        quantity: 0.5,
        price: 40000,
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const postCall = fetchSpy.mock.calls.find(
      (c) => typeof c[1] === 'object' && c[1]?.method === 'POST'
    );
    expect(postCall![0]).toBe('/api/portfolio/p1/holdings');
  });

  it('invalidates portfolio and portfolios queries', async () => {
    mockFetch({ portfolio: { _id: 'p1', holdings: [] } });

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useAddHolding('p1'), { wrapper });

    act(() => {
      result.current.mutate({
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        type: 'buy',
        quantity: 0.5,
        price: 40000,
      });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['portfolio', 'p1'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['portfolios'] });
    });
  });
});

describe('useRemoveHolding', () => {
  it('sends DELETE to holdings/[symbol] endpoint', async () => {
    const fetchSpy = mockFetch({ success: true });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRemoveHolding('p1'), { wrapper });

    act(() => {
      result.current.mutate('BTCUSDT');
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const deleteCall = fetchSpy.mock.calls.find(
      (c) => typeof c[1] === 'object' && c[1]?.method === 'DELETE'
    );
    expect(deleteCall![0]).toBe('/api/portfolio/p1/holdings/BTCUSDT');
  });
});

describe('useRecordTransaction', () => {
  it('sends POST to transactions endpoint', async () => {
    const fetchSpy = mockFetch({ portfolio: { _id: 'p1' } });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRecordTransaction('p1', 'BTCUSDT'), { wrapper });

    act(() => {
      result.current.mutate({ type: 'buy', quantity: 0.5, price: 50000 });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const postCall = fetchSpy.mock.calls.find(
      (c) => typeof c[1] === 'object' && c[1]?.method === 'POST'
    );
    expect(postCall![0]).toBe('/api/portfolio/p1/holdings/BTCUSDT/transactions');
  });

  it('invalidates portfolio and transactions queries', async () => {
    mockFetch({ portfolio: { _id: 'p1' } });

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useRecordTransaction('p1', 'BTCUSDT'), { wrapper });

    act(() => {
      result.current.mutate({ type: 'buy', quantity: 0.5, price: 50000 });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['portfolio', 'p1'] });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['transactions', 'p1', 'BTCUSDT'],
      });
    });
  });
});

describe('useTransactions', () => {
  it('fetches transactions for a holding', async () => {
    const data = { transactions: [{ type: 'buy', quantity: 1, price: 40000 }] };
    mockFetch(data);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useTransactions('p1', 'BTCUSDT'), { wrapper });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
  });
});

describe('toast notifications', () => {
  it('shows success toast on mutation success', async () => {
    mockFetch({ portfolio: { _id: 'p2', name: 'Trading' } }, 201);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCreatePortfolio(), { wrapper });

    act(() => {
      result.current.mutate('Trading');
    });

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Portfolio created');
    });
  });

  it('shows error toast on mutation failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Duplicate name' }), { status: 409 })
    );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCreatePortfolio(), { wrapper });

    act(() => {
      result.current.mutate('Existing');
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Duplicate name');
    });
  });
});
