import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/fetch-json', () => ({
  fetchJson: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { fetchJson } from '@/lib/fetch-json';
import { toast } from 'sonner';
import {
  useJournalEntries,
  useJournalEntry,
  useJournalTags,
  useCreateJournalEntry,
  useUpdateJournalEntry,
  useReviewJournalEntry,
  useDeleteJournalEntry,
} from './useJournal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

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

describe('useJournalEntries', () => {
  it('fetches entries with no filters', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ entries: [{ _id: 'j1' }], total: 1, page: 1, totalPages: 1 });
    const { result } = renderHook(() => useJournalEntries(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/journal');
  });

  it('accepts string symbol filter (backward compat)', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ entries: [], total: 0, page: 1, totalPages: 0 });
    const { result } = renderHook(() => useJournalEntries('BTCUSDT'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/journal?symbol=BTCUSDT');
  });

  it('accepts filter object', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ entries: [], total: 0, page: 1, totalPages: 0 });
    const { result } = renderHook(
      () => useJournalEntries({ tag: 'breakout', page: 2, limit: 10 }),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/journal?tag=breakout&page=2&limit=10');
  });

  it('builds URL with multiple filters', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ entries: [], total: 0, page: 1, totalPages: 0 });
    const { result } = renderHook(
      () => useJournalEntries({ symbol: 'BTCUSDT', action: 'buy', marketCondition: 'trending_up' }),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith(
      '/api/journal?symbol=BTCUSDT&action=buy&marketCondition=trending_up'
    );
  });
});

describe('useJournalEntry', () => {
  it('fetches single entry when id provided', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ entry: { _id: 'j1' } });
    const { result } = renderHook(() => useJournalEntry('j1'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/journal/j1');
  });

  it('does not fetch when id is null', () => {
    renderHook(() => useJournalEntry(null), {
      wrapper: createWrapper(),
    });
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

describe('useJournalTags', () => {
  it('fetches tags', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      tags: [{ tag: 'breakout', count: 5 }],
    });
    const { result } = renderHook(() => useJournalTags(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/journal/tags');
    expect(result.current.data?.tags).toHaveLength(1);
  });
});

describe('useCreateJournalEntry', () => {
  it('posts and shows success toast', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ entry: { _id: 'j1' } });
    const { result } = renderHook(() => useCreateJournalEntry(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      symbol: 'BTCUSDT',
      interval: '1h',
      signalScore: 45,
      signalTier: 'buy',
      action: 'buy',
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.success).toHaveBeenCalledWith('Journal entry created');
  });
});

describe('useUpdateJournalEntry', () => {
  it('patches and shows success toast', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ entry: { _id: 'j1' } });
    const { result } = renderHook(() => useUpdateJournalEntry(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ id: 'j1', notes: 'updated' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.success).toHaveBeenCalledWith('Journal entry updated');
  });
});

describe('useReviewJournalEntry', () => {
  it('marks entry as reviewed', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ entry: { _id: 'j1', reviewedAt: '2025-01-01' } });
    const { result } = renderHook(() => useReviewJournalEntry(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ id: 'j1', lessonsLearned: 'Good timing' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.success).toHaveBeenCalledWith('Entry reviewed');
    expect(fetchJson).toHaveBeenCalledWith('/api/journal/j1', expect.objectContaining({
      method: 'PATCH',
      body: expect.stringContaining('lessonsLearned'),
    }));
  });
});

describe('useDeleteJournalEntry', () => {
  it('deletes and shows success toast', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ success: true });
    const { result } = renderHook(() => useDeleteJournalEntry(), {
      wrapper: createWrapper(),
    });

    result.current.mutate('j1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.success).toHaveBeenCalledWith('Journal entry deleted');
  });
});
