import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import {
  useGlobalSignals,
  useLatestSignals,
  useLatestSignalForStyle,
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

  it('includes interval when provided', async () => {
    const fetchSpy = mockFetch({ signal: { score: 42, tier: 'buy' } });

    const { wrapper } = createWrapper();
    renderHook(() => useLatestSignalForStyle('BTCUSDT', 'day_trading', '1h'), {
      wrapper,
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/signals/latest?symbol=BTCUSDT&tradingStyle=day_trading&interval=1h',
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
