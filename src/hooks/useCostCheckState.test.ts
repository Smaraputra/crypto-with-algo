import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_INPUTS, STORAGE_KEY } from '@/lib/costs/cost-check-model';
import type {
  CostCheckMarketResponse,
  CostCheckRegimeResponse,
  CostCheckSymbolsResponse,
} from '@/types/cost-check';
import { useCostCheckState } from './useCostCheckState';

const mockMarket = {
  data: undefined as CostCheckMarketResponse | undefined,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null as { code?: string } | null,
  isPlaceholderData: false,
  refetch: vi.fn(),
};

const mockRegime = {
  data: undefined as CostCheckRegimeResponse | undefined,
  isLoading: false,
  isError: false,
  error: null as { code?: string } | null,
  refetch: vi.fn(),
};

const mockSymbols = {
  data: {
    symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', onboardDate: 0 }],
    asOf: 0,
    stale: false,
  } as CostCheckSymbolsResponse | undefined,
  isLoading: false,
  isError: false,
};

vi.mock('@/hooks/useCostCheck', () => ({
  useCostCheckSymbols: () => mockSymbols,
  useCostCheckMarket: () => mockMarket,
  useCostCheckRegime: () => mockRegime,
}));

function createMarketData(overrides: Partial<CostCheckMarketResponse> = {}): CostCheckMarketResponse {
  return {
    symbol: 'BTCUSDT',
    asOf: Date.now(),
    stale: false,
    markPrice: 60_000,
    funding: { rate: 0.0001, intervalHours: 8, nextFundingTime: Date.now() + 3_600_000 },
    venue: { minNotional: 50, minQty: 0.001, stepSize: 0.001, tickSize: 0.1, effectiveMinNotional: 60 },
    measurement: { interval: '15m', holdBars: 4, measuredHoldMs: 3_600_000, barsUsed: 999 },
    move: { medianPercent: 0.3, meanPercent: 0.4, p75Percent: 0.55, samples: 995, independentWindows: 249 },
    slippage: { bps: 2.5, source: 'depth', halfSpreadBps: 0.1, exceedsTopOfBook: false },
    onboardDate: 0,
    ...overrides,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('useCostCheckState', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/cost-check');
    mockMarket.data = createMarketData();
    mockMarket.isLoading = false;
    mockMarket.isFetching = false;
    mockMarket.isError = false;
    mockMarket.error = null;
    mockMarket.isPlaceholderData = false;
    mockMarket.refetch.mockClear();

    mockRegime.data = undefined;
    mockRegime.isLoading = false;
    mockRegime.isError = false;
    mockRegime.error = null;
    mockRegime.refetch.mockClear();

    mockSymbols.isLoading = false;
    mockSymbols.isError = false;
  });

  it('allows URL params to override stored inputs, and updateInputs saves to localStorage under STORAGE_KEY', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_INPUTS, symbol: 'ETHUSDT', holdMinutes: 15, margin: 500 })
    );
    window.history.replaceState(null, '', '/cost-check?symbol=SOLUSDT&holdMinutes=240');

    const { result } = renderHook(() => useCostCheckState(), { wrapper: createWrapper() });

    expect(result.current.inputs.symbol).toBe('SOLUSDT');
    expect(result.current.inputs.holdMinutes).toBe(240);
    expect(result.current.inputs.margin).toBe(500);

    act(() => {
      result.current.updateInputs({ margin: 750 });
    });

    expect(result.current.inputs.margin).toBe(750);
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) as string);
    expect(stored.symbol).toBe('SOLUSDT');
    expect(stored.margin).toBe(750);
  });

  it('falls back to defaults without throwing when storage is blocked', () => {
    const originalGetItem = window.localStorage.getItem;
    const originalSetItem = window.localStorage.setItem;

    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('Access denied');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded');
    });

    try {
      const { result } = renderHook(() => useCostCheckState(), { wrapper: createWrapper() });
      expect(result.current.inputs).toEqual(DEFAULT_INPUTS);

      expect(() => {
        act(() => {
          result.current.updateInputs({ leverage: 25 });
        });
      }).not.toThrow();

      expect(result.current.inputs.leverage).toBe(25);
    } finally {
      window.localStorage.getItem = originalGetItem;
      window.localStorage.setItem = originalSetItem;
    }
  });

  it('gives marketData null and marketLoading true when market data does not match the symbol', () => {
    mockMarket.data = createMarketData({ symbol: 'ETHUSDT' });

    const { result } = renderHook(() => useCostCheckState(), { wrapper: createWrapper() });

    expect(result.current.inputs.symbol).toBe('BTCUSDT');
    expect(result.current.marketData).toBeNull();
    expect(result.current.marketLoading).toBe(true);
  });

  it('gives marketData null and marketLoading true when measurement interval or hold bars mismatch', () => {
    // 60-minute hold expects 15m interval with 4 bars
    mockMarket.data = createMarketData({
      measurement: { interval: '1h', holdBars: 1, measuredHoldMs: 3_600_000, barsUsed: 999 },
    });

    const { result } = renderHook(() => useCostCheckState(), { wrapper: createWrapper() });

    expect(result.current.marketData).toBeNull();
    expect(result.current.marketLoading).toBe(true);
  });

  it('propagates slippageForOtherSize to the model when matching data has isPlaceholderData true', () => {
    mockMarket.data = createMarketData();
    mockMarket.isPlaceholderData = true;

    const { result } = renderHook(() => useCostCheckState(), { wrapper: createWrapper() });

    expect(result.current.marketData).not.toBeNull();
    expect(result.current.model.slippageSource).toBe('depth');
    expect(result.current.model.slippageForOtherSize).toBe(true);
  });

  it('sets marketProblem when market has an error with code venue_unreachable', () => {
    mockMarket.data = undefined;
    mockMarket.isError = true;
    mockMarket.error = { code: 'venue_unreachable' };

    const { result } = renderHook(() => useCostCheckState(), { wrapper: createWrapper() });

    expect(result.current.marketProblem).toBe('the exchange could not be reached');
    expect(result.current.marketLoading).toBe(false);
  });

  it('sets regime.problem when regime query fails', () => {
    mockRegime.isError = true;
    mockRegime.error = { code: 'venue_rate_limited' };

    const { result } = renderHook(() => useCostCheckState(), { wrapper: createWrapper() });

    expect(result.current.regime.problem).toBe('the exchange is rate limiting requests');
  });

  it('returns measuredSlippageBps only when source is depth', () => {
    mockMarket.data = createMarketData({
      slippage: { bps: 4.2, source: 'depth', halfSpreadBps: 0.2, exceedsTopOfBook: false },
    });

    const { result, rerender } = renderHook(() => useCostCheckState(), { wrapper: createWrapper() });
    expect(result.current.measuredSlippageBps).toBe(4.2);

    mockMarket.data = createMarketData({
      slippage: { bps: 5, source: 'fallback', halfSpreadBps: null, exceedsTopOfBook: false },
    });
    rerender();
    expect(result.current.measuredSlippageBps).toBeNull();
  });

  it('allows retrying market and regime queries', () => {
    const { result } = renderHook(() => useCostCheckState(), { wrapper: createWrapper() });

    result.current.retryMarket();
    expect(mockMarket.refetch).toHaveBeenCalledTimes(1);

    result.current.regime.retry();
    expect(mockRegime.refetch).toHaveBeenCalledTimes(1);
  });
});
