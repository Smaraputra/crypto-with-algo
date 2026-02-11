'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchJson } from '@/lib/fetch-json';
import type {
  ResearchNoteListResponse,
  ResearchNote,
  CreateResearchNoteInput,
  UpdateResearchNoteInput,
} from '@/types/research-note';

export interface ResearchNoteFilters {
  category?: string;
  tag?: string;
  search?: string;
  pinned?: boolean;
  page?: number;
  limit?: number;
  sort?: string;
}

function buildUrl(filters: ResearchNoteFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.category) params.set('category', filters.category);
  if (filters.tag) params.set('tag', filters.tag);
  if (filters.search) params.set('search', filters.search);
  if (filters.pinned) params.set('pinned', 'true');
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.sort) params.set('sort', filters.sort);
  const qs = params.toString();
  return qs ? `/api/research-notes?${qs}` : '/api/research-notes';
}

export function useResearchNotes(filters?: ResearchNoteFilters) {
  const normalized = filters ?? {};
  const url = buildUrl(normalized);

  return useQuery<ResearchNoteListResponse>({
    queryKey: ['research-notes', normalized],
    queryFn: () => fetchJson(url),
  });
}

export function useResearchNote(id: string | null) {
  return useQuery<{ note: ResearchNote }>({
    queryKey: ['research-note', id],
    queryFn: () => fetchJson(`/api/research-notes/${id}`),
    enabled: !!id,
  });
}

export function useCreateResearchNote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateResearchNoteInput) =>
      fetchJson('/api/research-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => toast.success('Research note created'),
    onError: (err) => toast.error(err.message || 'Failed to create note'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['research-notes'] });
    },
  });
}

export function useUpdateResearchNote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: UpdateResearchNoteInput & { id: string }) =>
      fetchJson(`/api/research-notes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => toast.success('Research note updated'),
    onError: (err) => toast.error(err.message || 'Failed to update note'),
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({ queryKey: ['research-notes'] });
      queryClient.invalidateQueries({ queryKey: ['research-note', variables.id] });
    },
  });
}

export function useDeleteResearchNote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/research-notes/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast.success('Research note deleted'),
    onError: (err) => toast.error(err.message || 'Failed to delete note'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['research-notes'] });
    },
  });
}
