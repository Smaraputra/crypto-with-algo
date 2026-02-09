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
  useCreateJournalEntry,
  useUpdateJournalEntry,
  useDeleteJournalEntry,
} from './useJournal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useJournalEntries', () => {
  it('fetches entries', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ entries: [{ _id: 'j1' }] });
    const { result } = renderHook(() => useJournalEntries(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/journal');
  });

  it('passes symbol filter', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ entries: [] });
    const { result } = renderHook(() => useJournalEntries('BTCUSDT'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/journal?symbol=BTCUSDT');
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
