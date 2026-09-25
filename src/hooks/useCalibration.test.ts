import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useCalibration } from './useCalibration';

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const BASE = { style: 'day_trading' as const, interval: '1h', source: 'composite' as const };

describe('useCalibration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // A fresh Response per call: a Response body can only be read once, so a
    // single shared instance makes the second query fail on a drained body.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ meta: {}, tiers: [], reliability: [], distribution: {}, cumulative: [] }),
          { status: 200 }
        )
      )
    );
  });

  it('requests the admin calibration route with the required filters', async () => {
    const { result } = renderHook(() => useCalibration(BASE), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain('/api/admin/calibration?');
    expect(url).toContain('style=day_trading');
    expect(url).toContain('interval=1h');
    expect(url).toContain('source=composite');
  });

  it('omits optional filters rather than sending empty values', async () => {
    const { result } = renderHook(() => useCalibration(BASE), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).not.toContain('symbol=');
    expect(url).not.toContain('configVersion=');
    expect(url).not.toContain('overlapping=');
  });

  it('sends configVersion 0 rather than dropping it as falsy', async () => {
    const { result } = renderHook(() => useCalibration({ ...BASE, configVersion: 0 }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(vi.mocked(globalThis.fetch).mock.calls[0][0] as string).toContain('configVersion=0');
  });

  it('keys the cache by the full filter set, so two filters do not share a result', async () => {
    const wrapper = createWrapper();
    const { result: first } = renderHook(() => useCalibration({ ...BASE, symbol: 'BTCUSDT' }), { wrapper });
    const { result: second } = renderHook(() => useCalibration({ ...BASE, symbol: 'ETHUSDT' }), { wrapper });

    await waitFor(() => expect(first.current.isSuccess).toBe(true));
    await waitFor(() => expect(second.current.isSuccess).toBe(true));

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });
});
