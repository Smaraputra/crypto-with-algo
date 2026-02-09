'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchJson } from '@/lib/fetch-json';
import type {
  BacktestResultListResponse,
  BacktestResultDetailResponse,
  SaveBacktestResultInput,
} from '@/types/backtest';

export function useBacktestResults() {
  return useQuery<BacktestResultListResponse>({
    queryKey: ['backtest-results'],
    queryFn: () => fetchJson('/api/backtests'),
  });
}

export function useBacktestResultDetail(id: string | null) {
  return useQuery<BacktestResultDetailResponse>({
    queryKey: ['backtest-result', id],
    queryFn: () => fetchJson(`/api/backtests/${id}`),
    enabled: !!id,
  });
}

export function useSaveBacktestResult() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: SaveBacktestResultInput) =>
      fetchJson('/api/backtests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => toast.success('Backtest result saved'),
    onError: (err) => toast.error(err.message || 'Failed to save backtest result'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['backtest-results'] });
    },
  });
}

export function useDeleteBacktestResult() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/backtests/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast.success('Backtest result deleted'),
    onError: (err) => toast.error(err.message || 'Failed to delete backtest result'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['backtest-results'] });
    },
  });
}
