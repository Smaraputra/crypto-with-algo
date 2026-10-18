import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDailyLevels, type LevelsResponse } from './useDailyLevels';

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

const MOCK_DATA: LevelsResponse = {
  asOf: '2026-10-18T22:00:00.000Z',
  levels: {
    BTCUSDT: {
      dayStart: 1700000000000,
      high: 60000,
      low: 58000,
      close: 59000,
      atr: 1500,
    },
    ETHUSDT: {
      dayStart: 1700000000000,
      high: 3000,
      low: 2900,
      close: 2950,
      atr: 100,
    },
  },
};

describe('useDailyLevels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('is disabled and does not call fetch when symbols is empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useDailyLevels([]), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches levels with sorted and encoded symbols in the URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(MOCK_DATA), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const { result } = renderHook(() => useDailyLevels(['ETHUSDT', 'BTCUSDT']), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(MOCK_DATA);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe('/api/market/levels?symbols=' + encodeURIComponent('BTCUSDT,ETHUSDT'));
  });
});
