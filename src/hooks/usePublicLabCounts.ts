'use client';

import { useContext } from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';

export interface PublicLabCounts {
  underTest: number;
  validated: number;
  notStarted: number;
  hypotheses: number;
  rejectedRules: number;
  ledgerTrials: number;
  asOf: string;
}

const fallbackClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

export function usePublicLabCounts() {
  const contextClient = useContext(QueryClientContext);
  return useQuery<PublicLabCounts>(
    {
      queryKey: ['public', 'lab-counts'],
      queryFn: () => fetchJson<PublicLabCounts>('/api/public/lab-counts'),
      staleTime: 5 * 60_000,
    },
    contextClient ?? fallbackClient
  );
}
