import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFocusMtf, type FocusMtfResponse } from './useFocusMtf';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const MOCK_DATA: FocusMtfResponse = {
  symbol: 'BTCUSDT',
  states: [
    {
      interval: '15m',
      asOf: 1700000000000,
      trend: 1,
      lastEvent: null,
      cvdSlope: 'rising',
      priceVsSma: 'above',
    },
    {
      interval: '1h',
      asOf: 1700000000000,
      trend: 0,
      lastEvent: null,
      cvdSlope: 'flat',
      priceVsSma: 'below',
    },
    {
      interval: '4h',
      asOf: 1700000000000,
      trend: -1,
      lastEvent: null,
      cvdSlope: 'falling',
      priceVsSma: 'below',
    },
    {
      interval: '1d',
      asOf: 1700000000000,
      trend: 1,
      lastEvent: null,
      cvdSlope: 'rising',
      priceVsSma: 'above',
    },
  ],
  priorDay: {
    dayStart: 1700000000000,
    high: 65000,
    low: 63000,
    close: 64500,
    atr: 1200,
  },
};

describe('useFocusMtf', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('is disabled and does not call fetch when symbol is empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useFocusMtf(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches focus mtf with encoded symbol in the URL and exposes the data', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(MOCK_DATA), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const { result } = renderHook(() => useFocusMtf('BTCUSDT'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(MOCK_DATA);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe('/api/focus/mtf?symbol=' + encodeURIComponent('BTCUSDT'));
  });
});
