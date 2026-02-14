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

export interface JournalFilters {
  symbol?: string;
  tag?: string;
  action?: string;
  setupType?: string;
  marketCondition?: string;
  status?: 'open' | 'closed';
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
  sort?: string;
}

function buildJournalUrl(filters: JournalFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.symbol) params.set('symbol', filters.symbol);
  if (filters.tag) params.set('tag', filters.tag);
  if (filters.action) params.set('action', filters.action);
  if (filters.setupType) params.set('setupType', filters.setupType);
  if (filters.marketCondition) params.set('marketCondition', filters.marketCondition);
  if (filters.status) params.set('status', filters.status);
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.sort) params.set('sort', filters.sort);
  const qs = params.toString();
  return qs ? `/api/journal?${qs}` : '/api/journal';
}

export function useJournalEntries(filters?: JournalFilters | string) {
  const normalizedFilters: JournalFilters =
    typeof filters === 'string' ? { symbol: filters } : (filters ?? {});
  const url = buildJournalUrl(normalizedFilters);

  return useQuery<JournalEntryListResponse>({
    queryKey: ['journal', normalizedFilters],
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

export function useJournalTags() {
  return useQuery<{ tags: Array<{ tag: string; count: number }> }>({
    queryKey: ['journal-tags'],
    queryFn: () => fetchJson('/api/journal/tags'),
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
      queryClient.invalidateQueries({ queryKey: ['journal-tags'] });
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
      queryClient.invalidateQueries({ queryKey: ['journal-tags'] });
    },
  });
}

export function useReviewJournalEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, lessonsLearned }: { id: string; lessonsLearned: string }) =>
      fetchJson(`/api/journal/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewedAt: new Date().toISOString(),
          lessonsLearned,
        }),
      }),
    onSuccess: () => toast.success('Entry reviewed'),
    onError: (err) => toast.error(err.message || 'Failed to review entry'),
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
      queryClient.invalidateQueries({ queryKey: ['journal-tags'] });
    },
  });
}
