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
  useUploadJournalScreenshot,
  useDeleteJournalScreenshot,
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
  it('posts the entry and leaves the success toast to the log sheet', async () => {
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
    expect(toast.success).not.toHaveBeenCalled();
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
  it('marks entry as reviewed and includes exitPrice and reviewedAt in request body', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ entry: { _id: 'j1', reviewedAt: '2025-01-01' } });
    const { result } = renderHook(() => useReviewJournalEntry(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      id: 'j1',
      exitPrice: 65000,
      outcomePnlPercent: 5.5,
      lessonsLearned: 'Good timing',
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.success).toHaveBeenCalledWith('Entry reviewed');
    expect(fetchJson).toHaveBeenCalledWith(
      '/api/journal/j1',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringMatching(/"exitPrice":65000.*"reviewedAt":/),
      })
    );
    const callArgs = vi.mocked(fetchJson).mock.calls[0];
    const body = JSON.parse(callArgs[1]?.body as string);
    expect(body.exitPrice).toBe(65000);
    expect(body.outcomePnlPercent).toBe(5.5);
    expect(body.lessonsLearned).toBe('Good timing');
    expect(typeof body.reviewedAt).toBe('string');
  });
});

describe('useUploadJournalScreenshot', () => {
  it('posts FormData with a file field and returns response without toast', async () => {
    const mockResponse = {
      entry: { _id: 'j1', screenshots: [{ fileId: 'f1' }] },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const { result } = renderHook(() => useUploadJournalScreenshot(), {
      wrapper: createWrapper(),
    });

    const file = new File(['content'], 'chart.png', { type: 'image/png' });
    result.current.mutate({ entryId: 'j1', file });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/journal/j1/screenshots',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(FormData),
      })
    );
    const postBody = fetchSpy.mock.calls[0][1]?.body as FormData;
    expect(postBody.get('file')).toBe(file);
    expect(toast.success).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('surfaces the server error message on non-OK response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Screenshots can be at most 5 MB.' }),
    } as Response);

    const { result } = renderHook(() => useUploadJournalScreenshot(), {
      wrapper: createWrapper(),
    });

    const file = new File(['content'], 'big.png', { type: 'image/png' });
    result.current.mutate({ entryId: 'j1', file });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Screenshots can be at most 5 MB.');
    expect(toast.error).not.toHaveBeenCalled(); // component displays inline state
    fetchSpy.mockRestore();
  });
});

describe('useDeleteJournalScreenshot', () => {
  it('sends DELETE to /api/journal/screenshots/{fileId} without a success toast', async () => {
    vi.mocked(fetchJson).mockResolvedValueOnce({ success: true });
    const { result } = renderHook(() => useDeleteJournalScreenshot(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ fileId: 'f1', entryId: 'j1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/journal/screenshots/f1', {
      method: 'DELETE',
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows error toast on failure', async () => {
    vi.mocked(fetchJson).mockRejectedValueOnce(new Error('Failed to delete screenshot'));
    const { result } = renderHook(() => useDeleteJournalScreenshot(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ fileId: 'f1', entryId: 'j1' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('Failed to delete screenshot');
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
