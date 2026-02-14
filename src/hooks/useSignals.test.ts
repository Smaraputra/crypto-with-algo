import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import {
  useSignals,
  useLatestSignal,
  useComputeSignal,
  useGlobalSignals,
  useLatestSignals,
  useLatestSignalForStyle,
  useComputeGlobalSignal,
} from './useSignals';

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

// --- Global signal hooks ---

describe('useGlobalSignals', () => {
  it('does not fetch when symbol is null', () => {
    const fetchSpy = mockFetch({ signals: [] });

    const { wrapper } = createWrapper();
    renderHook(() => useGlobalSignals(null), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches with symbol only', async () => {
    const fetchSpy = mockFetch({ signals: [] });

    const { wrapper } = createWrapper();
    renderHook(() => useGlobalSignals('BTCUSDT'), { wrapper });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/signals/global?'),
        undefined
      );
    });
  });

  it('includes tradingStyle and interval params', async () => {
    const fetchSpy = mockFetch({ signals: [] });

    const { wrapper } = createWrapper();
    renderHook(() => useGlobalSignals('BTCUSDT', 'scalping', '1m', 20), {
      wrapper,
    });

    await waitFor(() => {
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('symbol=BTCUSDT');
      expect(url).toContain('tradingStyle=scalping');
      expect(url).toContain('interval=1m');
      expect(url).toContain('limit=20');
    });
  });

  it('returns signal data', async () => {
    const mockData = {
      signals: [
        { _id: 'gs1', symbol: 'BTCUSDT', tradingStyle: 'scalping', score: 55 },
      ],
    };
    mockFetch(mockData);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useGlobalSignals('BTCUSDT', 'scalping'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.data?.signals).toHaveLength(1);
      expect(result.current.data?.signals[0].score).toBe(55);
    });
  });

  it('uses correct query key', () => {
    mockFetch({ signals: [] });

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useGlobalSignals('BTCUSDT', 'day_trading', '1h', 30), {
      wrapper,
    });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual([
      'globalSignals',
      'BTCUSDT',
      'day_trading',
      '1h',
      30,
    ]);
  });
});

describe('useLatestSignals', () => {
  it('does not fetch when symbol is null', () => {
    const fetchSpy = mockFetch({});

    const { wrapper } = createWrapper();
    renderHook(() => useLatestSignals(null), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches latest signals for all styles', async () => {
    const fetchSpy = mockFetch({
      signals: {
        scalping: { score: 55 },
        day_trading: { score: 45 },
        swing_trading: null,
        position_trading: { score: 30 },
      },
    });

    const { wrapper } = createWrapper();
    renderHook(() => useLatestSignals('BTCUSDT'), { wrapper });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/signals/latest?symbol=BTCUSDT',
        undefined
      );
    });
  });

  it('returns data for all styles', async () => {
    const mockData = {
      signals: {
        scalping: { score: 55, tier: 'buy' },
        day_trading: { score: 45, tier: 'buy' },
        swing_trading: null,
        position_trading: { score: 30, tier: 'neutral' },
      },
    };
    mockFetch(mockData);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useLatestSignals('BTCUSDT'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.data?.signals.scalping?.score).toBe(55);
      expect(result.current.data?.signals.swing_trading).toBeNull();
    });
  });
});

describe('useLatestSignalForStyle', () => {
  it('does not fetch when symbol is null', () => {
    const fetchSpy = mockFetch({});

    const { wrapper } = createWrapper();
    renderHook(() => useLatestSignalForStyle(null, 'scalping'), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fetch when tradingStyle is null', () => {
    const fetchSpy = mockFetch({});

    const { wrapper } = createWrapper();
    renderHook(() => useLatestSignalForStyle('BTCUSDT', null), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches signal for specific style', async () => {
    const fetchSpy = mockFetch({ signal: { score: 55, tier: 'buy' } });

    const { wrapper } = createWrapper();
    renderHook(() => useLatestSignalForStyle('BTCUSDT', 'scalping'), {
      wrapper,
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/signals/latest?symbol=BTCUSDT&tradingStyle=scalping',
        undefined
      );
    });
  });

  it('returns single signal', async () => {
    mockFetch({ signal: { score: 72, tier: 'strong_buy' } });

    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useLatestSignalForStyle('BTCUSDT', 'swing_trading'),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.data?.signal?.score).toBe(72);
    });
  });
});

describe('useComputeGlobalSignal', () => {
  it('returns a mutation', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useComputeGlobalSignal(), { wrapper });

    expect(result.current.mutate).toBeDefined();
    expect(result.current.isPending).toBe(false);
  });

  it('calls POST with tradingStyle in body', async () => {
    const fetchSpy = mockFetch({
      signal: { _id: 's1', symbol: 'BTCUSDT', score: 40, tier: 'buy' },
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useComputeGlobalSignal(), { wrapper });

    result.current.mutate({
      symbol: 'BTCUSDT',
      interval: '1m',
      tradingStyle: 'scalping',
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/signals/compute',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            symbol: 'BTCUSDT',
            interval: '1m',
            tradingStyle: 'scalping',
          }),
        })
      );
    });
  });

  it('invalidates globalSignals queries on success', async () => {
    mockFetch({
      signal: { _id: 's1', symbol: 'BTCUSDT', score: 50, tier: 'buy' },
    });

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useComputeGlobalSignal(), { wrapper });

    result.current.mutate({
      symbol: 'BTCUSDT',
      tradingStyle: 'day_trading',
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: ['globalSignals', 'BTCUSDT'],
        })
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: ['globalSignals', 'latest', 'BTCUSDT'],
        })
      );
    });
  });
});
