import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

const mockToast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: mockToast }));

import {
  useStrategies,
  useStrategy,
  useCreateStrategy,
  useUpdateStrategy,
  useDeleteStrategy,
} from './useStrategies';
import { mockStrategy, mockCreateStrategyInput } from '@/__fixtures__/strategies';

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

describe('useStrategies', () => {
  it('fetches strategy list', async () => {
    mockFetch({ strategies: [mockStrategy] });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useStrategies(), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.strategies).toHaveLength(1);
    });
  });
});

describe('useStrategy', () => {
  it('fetches single strategy by id', async () => {
    mockFetch({ strategy: mockStrategy });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useStrategy('strat-1'), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.strategy.name).toBe('BTC Momentum');
    });
  });

  it('does not fetch when id is null', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useStrategy(null), { wrapper });
    expect(result.current.isFetching).toBe(false);
  });
});

describe('useCreateStrategy', () => {
  it('calls POST and shows toast on success', async () => {
    const spy = mockFetch({ strategy: mockStrategy }, 201);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCreateStrategy(), { wrapper });

    await act(async () => {
      result.current.mutate(mockCreateStrategyInput);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith('/api/strategies', expect.objectContaining({ method: 'POST' }));
    expect(mockToast.success).toHaveBeenCalledWith('Strategy created');
  });

  it('shows error toast on failure', async () => {
    mockFetch({ error: 'fail' }, 400);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCreateStrategy(), { wrapper });

    await act(async () => {
      result.current.mutate(mockCreateStrategyInput);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToast.error).toHaveBeenCalled();
  });
});

describe('useUpdateStrategy', () => {
  it('calls PATCH and shows toast on success', async () => {
    const spy = mockFetch({ strategy: { ...mockStrategy, name: 'Updated' } });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useUpdateStrategy(), { wrapper });

    await act(async () => {
      result.current.mutate({ id: 'strat-1', name: 'Updated' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      '/api/strategies/strat-1',
      expect.objectContaining({ method: 'PATCH' })
    );
    expect(mockToast.success).toHaveBeenCalledWith('Strategy updated');
  });
});

describe('useDeleteStrategy', () => {
  it('calls DELETE and shows toast on success', async () => {
    const spy = mockFetch({ success: true });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDeleteStrategy(), { wrapper });

    await act(async () => {
      result.current.mutate('strat-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      '/api/strategies/strat-1',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(mockToast.success).toHaveBeenCalledWith('Strategy deleted');
  });
});
