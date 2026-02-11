'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { CryptoNewsResponse } from '@/types/news';

export function useLatestNews(categories?: string) {
  const params = categories ? `?categories=${encodeURIComponent(categories)}` : '';

  return useQuery<CryptoNewsResponse>({
    queryKey: ['news', categories ?? 'all'],
    queryFn: () => fetchJson(`/api/news${params}`),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
