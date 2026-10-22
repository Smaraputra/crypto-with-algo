'use client';

import { useQuery } from '@tanstack/react-query';

import { fetchJson } from '@/lib/fetch-json';
import type { LabV4Response } from '@/lib/signals/lab/view';

export function useSignalLabV4(symbol?: string) {
  const queryKey = symbol ? ['signals', 'lab-v4', symbol] : ['signals', 'lab-v4'];
  const url = symbol
    ? `/api/signals/lab-v4?symbol=${encodeURIComponent(symbol)}`
    : '/api/signals/lab-v4';

  return useQuery<LabV4Response>({
    queryKey,
    queryFn: () => fetchJson(url),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}
