'use client';

import { useQuery } from '@tanstack/react-query';
import type { Ticker24h } from '@/types/market';

export function useTickers() {
  return useQuery<Ticker24h[]>({
    queryKey: ['tickers'],
    queryFn: async () => {
      const res = await fetch('/api/prices');
      if (!res.ok) throw new Error('Failed to fetch tickers');
      return res.json();
    },
    refetchInterval: 30_000,
  });
}
