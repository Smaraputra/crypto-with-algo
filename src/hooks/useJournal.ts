'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchJson } from '@/lib/fetch-json';
import type {
  JournalEntryListResponse,
  JournalEntryResponse,
  CreateJournalEntryInput,
  UpdateJournalEntryInput,
} from '@/types/journal';

export function useJournalEntries(symbol?: string) {
  const url = symbol ? `/api/journal?symbol=${symbol}` : '/api/journal';
  return useQuery<JournalEntryListResponse>({
    queryKey: symbol ? ['journal', symbol] : ['journal'],
    queryFn: () => fetchJson(url),
  });
}

export function useJournalEntry(id: string | null) {
  return useQuery<JournalEntryResponse>({
    queryKey: ['journal-entry', id],
    queryFn: () => fetchJson(`/api/journal/${id}`),
    enabled: !!id,
  });
}

export function useCreateJournalEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateJournalEntryInput) =>
      fetchJson('/api/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => toast.success('Journal entry created'),
    onError: (err) => toast.error(err.message || 'Failed to create journal entry'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['journal'] });
    },
  });
}

export function useUpdateJournalEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: UpdateJournalEntryInput & { id: string }) =>
      fetchJson(`/api/journal/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => toast.success('Journal entry updated'),
    onError: (err) => toast.error(err.message || 'Failed to update journal entry'),
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({ queryKey: ['journal'] });
      queryClient.invalidateQueries({ queryKey: ['journal-entry', variables.id] });
    },
  });
}

export function useDeleteJournalEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/journal/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast.success('Journal entry deleted'),
    onError: (err) => toast.error(err.message || 'Failed to delete journal entry'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['journal'] });
    },
  });
}
