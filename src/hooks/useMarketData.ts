'use client';

import { useQuery } from '@tanstack/react-query';
import type { OHLCV } from '@/types/market';

export function useMarketData(symbol: string, interval: string, limit = 500) {
  return useQuery<OHLCV[]>({
    queryKey: ['ohlcv', symbol, interval, limit],
    queryFn: async () => {
      const params = new URLSearchParams({
        symbol,
        interval,
        limit: limit.toString(),
      });
      const res = await fetch(`/api/prices/history?${params}`);
      if (!res.ok) throw new Error('Failed to fetch market data');
      return res.json();
    },
    staleTime: 60_000,
    enabled: !!symbol,
  });
}
