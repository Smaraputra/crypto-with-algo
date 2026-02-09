'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { fetchJson } from '@/lib/fetch-json';
import type { CompositeSignal } from '@/types/signal';

interface SignalsResponse {
  signals: Array<CompositeSignal & { _id: string; createdAt: string }>;
}

interface ComputeResponse {
  signal: CompositeSignal & { _id: string };
}

const SIGNAL_STALE_TIME = 60 * 1000; // 1 minute

export function useSignals(
  symbol?: string | null,
  tier?: string | null,
  limit = 50
) {
  const params = new URLSearchParams();
  if (symbol) params.set('symbol', symbol);
  if (tier) params.set('tier', tier);
  params.set('limit', String(limit));

  return useQuery<SignalsResponse>({
    queryKey: ['signals', symbol, tier, limit],
    queryFn: () => fetchJson(`/api/signals?${params}`),
    staleTime: SIGNAL_STALE_TIME,
  });
}

export function useLatestSignal(symbol: string | null) {
  return useQuery<SignalsResponse>({
    queryKey: ['signals', 'latest', symbol],
    queryFn: () => fetchJson(`/api/signals?symbol=${symbol}&limit=1`),
    enabled: !!symbol,
    staleTime: SIGNAL_STALE_TIME,
  });
}

export function useComputeSignal() {
  const queryClient = useQueryClient();

  return useMutation<ComputeResponse, Error, { symbol: string; interval?: string }>({
    mutationFn: (input) =>
      fetchJson('/api/signals/compute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['signals', variables.symbol],
      });
      void queryClient.invalidateQueries({
        queryKey: ['signals', 'latest', variables.symbol],
      });
    },
  });
}
