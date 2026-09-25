import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/fetch-json', () => ({
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/fetch-json';
import { useIndicatorSnapshot } from './useIndicatorSnapshot';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { IndicatorSnapshot } from '@/types/indicator-snapshot';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const snapshot = {
  rsi: 62.4,
  macdLine: 12.5,
  macdSignal: 10.2,
  macdHistogram: 2.3,
  bollingerUpper: 105,
  bollingerMiddle: 100,
  bollingerLower: 95,
  ema12: 101,
  ema26: 99,
  sma50: 98,
  sma200: 90,
  atr: 1.75,
  stochRsiK: 75,
  stochRsiD: 70,
  williamsR: -25,
  obv: 123456,
  mfi: 60,
  superTrendDirection: 'up',
  fearGreedIndex: 61,
  fearGreedLabel: 'Greed',
} satisfies IndicatorSnapshot;

describe('useIndicatorSnapshot', () => {
  it('asks for the interval it was given', async () => {
    // The old implementation took this argument and dropped it, reading
    // whichever interval the legacy per-user scorer had last written.
    vi.mocked(fetchJson).mockResolvedValue({
      snapshot,
      symbol: 'BTCUSDT',
      interval: '15m',
      candleTimestamp: 1700000000000,
    });

    const { result } = renderHook(() => useIndicatorSnapshot('BTCUSDT', '15m'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith(
      '/api/indicators/snapshot?symbol=BTCUSDT&interval=15m'
    );
  });

  it('defaults to 1h, matching the journal form', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      snapshot,
      symbol: 'BTCUSDT',
      interval: '1h',
      candleTimestamp: 1700000000000,
    });

    const { result } = renderHook(() => useIndicatorSnapshot('BTCUSDT'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith(
      '/api/indicators/snapshot?symbol=BTCUSDT&interval=1h'
    );
  });

  it('returns the reading as the server computed it, with no client-side parsing', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      snapshot,
      symbol: 'BTCUSDT',
      interval: '1h',
      candleTimestamp: 1700000000000,
    });

    const { result } = renderHook(() => useIndicatorSnapshot('BTCUSDT'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(snapshot);
  });

  it('does not fetch when symbol is null', () => {
    renderHook(() => useIndicatorSnapshot(null), {
      wrapper: createWrapper(),
    });
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
