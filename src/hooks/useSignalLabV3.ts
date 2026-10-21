'use client';

import { useQuery } from '@tanstack/react-query';

import { fetchJson } from '@/lib/fetch-json';
import type { LabV3Response } from '@/lib/signals/lab/view';

export function useSignalLabV3() {
  return useQuery<LabV3Response>({
    queryKey: ['signals', 'lab-v3'],
    queryFn: () => fetchJson('/api/signals/lab-v3'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
