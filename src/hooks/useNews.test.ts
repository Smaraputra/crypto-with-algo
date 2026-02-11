import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/fetch-json', () => ({
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/fetch-json';
import { useLatestNews } from './useNews';
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

describe('useLatestNews', () => {
  it('fetches news without categories', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ articles: [] });

    const { result } = renderHook(() => useLatestNews(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/news');
  });

  it('fetches news with categories', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ articles: [] });

    const { result } = renderHook(() => useLatestNews('BTC,ETH'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith(
      expect.stringContaining('categories=BTC%2CETH')
    );
  });
});
