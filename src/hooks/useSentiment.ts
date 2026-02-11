'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { SentimentData } from '@/types/signal';

export function useFearAndGreed() {
  return useQuery<{ sentiment: SentimentData }>({
    queryKey: ['sentiment'],
    queryFn: () => fetchJson('/api/sentiment'),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
