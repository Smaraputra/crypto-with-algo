import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

const mockToast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: mockToast }));

import {
  useAlerts,
  useAlert,
  useCreateAlert,
  useUpdateAlert,
  useDeleteAlert,
  useAcknowledgeAlert,
  useUnreadAlertCount,
} from './useAlerts';

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

describe('useAlerts', () => {
  it('fetches alert list', async () => {
    const data = {
      alerts: [
        { _id: 'a1', type: 'price_above', symbol: 'BTCUSDT', status: 'active' },
      ],
    };
    mockFetch(data);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAlerts(), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.alerts).toHaveLength(1);
    });
  });

  it('uses query key ["alerts"] without status', () => {
    mockFetch({ alerts: [] });

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useAlerts(), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual(['alerts']);
  });

  it('uses query key ["alerts", status] with status filter', () => {
    mockFetch({ alerts: [] });

    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useAlerts('active'), { wrapper });

    const cache = queryClient.getQueryCache().findAll();
    expect(cache[0].queryKey).toEqual(['alerts', 'active']);
  });

  it('fetches from /api/alerts?status=triggered when status provided', async () => {
    const fetchSpy = mockFetch({ alerts: [] });

    const { wrapper } = createWrapper();
    renderHook(() => useAlerts('triggered'), { wrapper });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/alerts?status=triggered', undefined);
    });
  });
});

describe('useAlert', () => {
  it('fetches single alert by id', async () => {
    const data = {
      alert: { _id: 'a1', type: 'price_above', symbol: 'BTCUSDT' },
    };
    mockFetch(data);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAlert('a1'), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.alert.type).toBe('price_above');
    });
  });

  it('does not fetch when id is null', () => {
    const fetchSpy = mockFetch({});

    const { wrapper } = createWrapper();
    renderHook(() => useAlert(null), { wrapper });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('useCreateAlert', () => {
  it('sends POST to /api/alerts', async () => {
    const fetchSpy = mockFetch({ alert: { _id: 'a1' } }, 201);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCreateAlert(), { wrapper });

    act(() => {
      result.current.mutate({
        type: 'price_above',
        symbol: 'BTCUSDT',
        targetPrice: 100000,
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const postCall = fetchSpy.mock.calls.find(
      (c) => typeof c[1] === 'object' && c[1]?.method === 'POST'
    );
    expect(postCall![0]).toBe('/api/alerts');
  });

  it('invalidates alerts query on settle', async () => {
    mockFetch({ alert: { _id: 'a1' } }, 201);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreateAlert(), { wrapper });

    act(() => {
      result.current.mutate({
        type: 'price_above',
        symbol: 'BTCUSDT',
        targetPrice: 100000,
      });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['alerts'] });
    });
  });

  it('shows success toast', async () => {
    mockFetch({ alert: { _id: 'a1' } }, 201);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCreateAlert(), { wrapper });

    act(() => {
      result.current.mutate({
        type: 'price_above',
        symbol: 'BTCUSDT',
        targetPrice: 100000,
      });
    });

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Alert created');
    });
  });

  it('shows error toast on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Maximum of 50 alerts' }), { status: 400 })
    );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCreateAlert(), { wrapper });

    act(() => {
      result.current.mutate({
        type: 'price_above',
        symbol: 'BTCUSDT',
        targetPrice: 100000,
      });
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Maximum of 50 alerts');
    });
  });
});

describe('useUpdateAlert', () => {
  it('sends PATCH to /api/alerts/[id]', async () => {
    const fetchSpy = mockFetch({ alert: { _id: 'a1', status: 'paused' } });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useUpdateAlert(), { wrapper });

    act(() => {
      result.current.mutate({ id: 'a1', status: 'paused' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const patchCall = fetchSpy.mock.calls.find(
      (c) => typeof c[1] === 'object' && c[1]?.method === 'PATCH'
    );
    expect(patchCall![0]).toBe('/api/alerts/a1');
  });

  it('invalidates alerts and alert queries', async () => {
    mockFetch({ alert: { _id: 'a1' } });

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateAlert(), { wrapper });

    act(() => {
      result.current.mutate({ id: 'a1', status: 'paused' });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['alerts'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['alert', 'a1'] });
    });
  });
});

describe('useDeleteAlert', () => {
  it('sends DELETE to /api/alerts/[id]', async () => {
    const fetchSpy = mockFetch({ success: true });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDeleteAlert(), { wrapper });

    act(() => {
      result.current.mutate('a1');
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const deleteCall = fetchSpy.mock.calls.find(
      (c) => typeof c[1] === 'object' && c[1]?.method === 'DELETE'
    );
    expect(deleteCall![0]).toBe('/api/alerts/a1');
  });
});

describe('useAcknowledgeAlert', () => {
  it('sends PATCH with notifiedAt', async () => {
    const fetchSpy = mockFetch({ alert: { _id: 'a1' } });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAcknowledgeAlert(), { wrapper });

    act(() => {
      result.current.mutate('a1');
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const patchCall = fetchSpy.mock.calls.find(
      (c) => typeof c[1] === 'object' && c[1]?.method === 'PATCH'
    );
    expect(patchCall![0]).toBe('/api/alerts/a1');
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.notifiedAt).toBeDefined();
  });

  it('invalidates alerts queries on settle', async () => {
    mockFetch({ alert: { _id: 'a1' } });

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useAcknowledgeAlert(), { wrapper });

    act(() => {
      result.current.mutate('a1');
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['alerts'] });
    });
  });
});

describe('useUnreadAlertCount', () => {
  it('returns count of triggered alerts without notifiedAt', async () => {
    mockFetch({
      alerts: [
        { _id: 'a1', status: 'triggered', notifiedAt: null },
        { _id: 'a2', status: 'triggered', notifiedAt: '2024-01-01' },
        { _id: 'a3', status: 'triggered', notifiedAt: null },
      ],
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useUnreadAlertCount(), { wrapper });

    await waitFor(() => {
      expect(result.current).toBe(2);
    });
  });

  it('returns 0 when no triggered alerts', async () => {
    mockFetch({ alerts: [] });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useUnreadAlertCount(), { wrapper });

    await waitFor(() => {
      expect(result.current).toBe(0);
    });
  });
});
