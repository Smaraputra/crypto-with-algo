import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { usePublicLabCounts, type PublicLabCounts } from './usePublicLabCounts';

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const MOCK_DATA: PublicLabCounts = {
  underTest: 12,
  validated: 0,
  notStarted: 1,
  hypotheses: 13,
  rejectedRules: 1,
  ledgerTrials: 2204,
  asOf: '2026-10-24T12:00:00.000Z',
};

describe('usePublicLabCounts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls /api/public/lab-counts and returns data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(MOCK_DATA), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { result } = renderHook(() => usePublicLabCounts(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(MOCK_DATA);
    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toBe('/api/public/lab-counts');
  });

  it('surfaces a non-OK response as an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Lab counts are unavailable' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { result } = renderHook(() => usePublicLabCounts(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('Lab counts are unavailable');
  });
});
