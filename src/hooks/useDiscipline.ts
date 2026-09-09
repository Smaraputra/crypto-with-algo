'use client';

import { useQuery } from '@tanstack/react-query';
import type { DisciplineNudge } from '@/lib/discipline';

async function fetchDiscipline(symbol?: string): Promise<DisciplineNudge[]> {
  const params = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
  const res = await fetch(`/api/journal/discipline${params}`);
  if (!res.ok) throw new Error('Failed to fetch discipline status');
  const data = await res.json();
  return data.nudges ?? [];
}

export function useDiscipline(symbol?: string, enabled = true) {
  return useQuery({
    queryKey: ['discipline', symbol ?? null],
    queryFn: () => fetchDiscipline(symbol),
    staleTime: 60_000,
    retry: 1,
    enabled,
  });
}
