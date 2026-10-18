'use client';

import { useQuery } from '@tanstack/react-query';

import { fetchJson } from '@/lib/fetch-json';
import type { LabResponse } from '@/lib/signals/lab/view';

export function useSignalLab() {
  return useQuery<LabResponse>({
    queryKey: ['signals', 'lab'],
    queryFn: () => fetchJson('/api/signals/lab'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
