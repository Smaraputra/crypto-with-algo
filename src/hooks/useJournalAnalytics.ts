'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { JournalAnalyticsResponse } from '@/types/journal-analytics';

export function useJournalAnalytics() {
  return useQuery<JournalAnalyticsResponse>({
    queryKey: ['journal-analytics'],
    queryFn: () => fetchJson('/api/journal/analytics'),
    staleTime: 2 * 60 * 1000, // 2 minutes
  });
}
