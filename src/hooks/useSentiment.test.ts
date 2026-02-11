import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/fetch-json', () => ({
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/fetch-json';
import { useFearAndGreed } from './useSentiment';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return Wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useFearAndGreed', () => {
  it('fetches sentiment data', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      sentiment: { fearGreedIndex: 50, label: 'Neutral' },
    });

    const { result } = renderHook(() => useFearAndGreed(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/sentiment');
    expect(result.current.data?.sentiment.fearGreedIndex).toBe(50);
  });
});
