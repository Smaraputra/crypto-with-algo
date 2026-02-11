import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/fetch-json', () => ({
  fetchJson: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { fetchJson } from '@/lib/fetch-json';
import {
  useResearchNotes,
  useResearchNote,
  useCreateResearchNote,
  useUpdateResearchNote,
  useDeleteResearchNote,
} from './useResearchNotes';
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

describe('useResearchNotes', () => {
  it('fetches notes without filters', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ notes: [], total: 0, page: 1, totalPages: 0 });

    const { result } = renderHook(() => useResearchNotes(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/research-notes');
  });

  it('fetches notes with filters', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ notes: [], total: 0, page: 1, totalPages: 0 });

    const { result } = renderHook(
      () => useResearchNotes({ category: 'strategy', search: 'btc' }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith(
      expect.stringContaining('category=strategy')
    );
    expect(fetchJson).toHaveBeenCalledWith(
      expect.stringContaining('search=btc')
    );
  });
});

describe('useResearchNote', () => {
  it('fetches a single note', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ note: { _id: 'rn-1' } });

    const { result } = renderHook(() => useResearchNote('rn-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/research-notes/rn-1');
  });

  it('does not fetch when id is null', () => {
    const { result } = renderHook(() => useResearchNote(null), {
      wrapper: createWrapper(),
    });

    expect(result.current.isFetching).toBe(false);
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

describe('useCreateResearchNote', () => {
  it('creates a note via POST', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ note: { _id: 'rn-new' } });

    const { result } = renderHook(() => useCreateResearchNote(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ title: 'New note', category: 'strategy' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/research-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New note', category: 'strategy' }),
    });
  });
});

describe('useUpdateResearchNote', () => {
  it('updates a note via PATCH', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ note: { _id: 'rn-1' } });

    const { result } = renderHook(() => useUpdateResearchNote(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ id: 'rn-1', title: 'Updated' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/research-notes/rn-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated' }),
    });
  });
});

describe('useDeleteResearchNote', () => {
  it('deletes a note via DELETE', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ success: true });

    const { result } = renderHook(() => useDeleteResearchNote(), {
      wrapper: createWrapper(),
    });

    result.current.mutate('rn-1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/research-notes/rn-1', {
      method: 'DELETE',
    });
  });
});
