'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchJson } from '@/lib/fetch-json';
import type {
  StrategyListResponse,
  StrategyResponse,
  CreateStrategyInput,
  UpdateStrategyInput,
} from '@/types/strategy';

export function useStrategies() {
  return useQuery<StrategyListResponse>({
    queryKey: ['strategies'],
    queryFn: () => fetchJson('/api/strategies'),
  });
}

export function useStrategy(id: string | null) {
  return useQuery<StrategyResponse>({
    queryKey: ['strategy', id],
    queryFn: () => fetchJson(`/api/strategies/${id}`),
    enabled: !!id,
  });
}

export function useCreateStrategy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateStrategyInput) =>
      fetchJson('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => toast.success('Strategy created'),
    onError: (err) => toast.error(err.message || 'Failed to create strategy'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['strategies'] });
    },
  });
}

export function useUpdateStrategy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: UpdateStrategyInput & { id: string }) =>
      fetchJson(`/api/strategies/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => toast.success('Strategy updated'),
    onError: (err) => toast.error(err.message || 'Failed to update strategy'),
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({ queryKey: ['strategies'] });
      queryClient.invalidateQueries({ queryKey: ['strategy', variables.id] });
    },
  });
}

export function useDeleteStrategy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/strategies/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast.success('Strategy deleted'),
    onError: (err) => toast.error(err.message || 'Failed to delete strategy'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['strategies'] });
    },
  });
}
