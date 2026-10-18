'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { PriorDayLevels } from '@/lib/market/levels';

export interface LevelsResponse {
  asOf: string;
  levels: Record<string, PriorDayLevels | null>;
}

export function useDailyLevels(symbols: string[]) {
  const sorted = [...symbols].sort();
  const sortedKey = sorted.join(',');

  return useQuery<LevelsResponse>({
    queryKey: ['market', 'levels', sortedKey],
    queryFn: () =>
      fetchJson<LevelsResponse>(
        '/api/market/levels?symbols=' + encodeURIComponent(sorted.join(','))
      ),
    enabled: symbols.length > 0,
    staleTime: 600_000,
    refetchInterval: 600_000,
  });
}
