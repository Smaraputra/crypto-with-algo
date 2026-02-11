import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/fetch-json', () => ({
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/fetch-json';
import { useJournalAnalytics } from './useJournalAnalytics';
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

describe('useJournalAnalytics', () => {
  it('fetches journal analytics', async () => {
    const mockData = {
      summary: { totalTrades: 10, wins: 6, losses: 4 },
      byTag: [],
      byAction: [],
      bySetupType: [],
      byMarketCondition: [],
      byMonth: [],
      bySignalTier: [],
    };
    vi.mocked(fetchJson).mockResolvedValue(mockData);

    const { result } = renderHook(() => useJournalAnalytics(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/journal/analytics');
    expect(result.current.data?.summary.totalTrades).toBe(10);
  });
});
