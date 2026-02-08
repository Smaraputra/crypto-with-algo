'use client';

import { useQuery } from '@tanstack/react-query';
import type { Symbol } from '@/types/market';

export function useSymbols() {
  return useQuery<Symbol[]>({
    queryKey: ['symbols'],
    queryFn: async () => {
      const res = await fetch('/api/symbols');
      if (!res.ok) throw new Error('Failed to fetch symbols');
      return res.json();
    },
    staleTime: 60 * 60 * 1000, // 1 hour
  });
}
