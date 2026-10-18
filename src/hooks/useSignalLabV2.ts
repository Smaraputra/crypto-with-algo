'use client';

import { useQuery } from '@tanstack/react-query';

import { fetchJson } from '@/lib/fetch-json';
import type { LabV2Response } from '@/lib/signals/lab/view';

export function useSignalLabV2() {
  return useQuery<LabV2Response>({
    queryKey: ['signals', 'lab-v2'],
    queryFn: () => fetchJson('/api/signals/lab-v2'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
