'use client';

import { useQuery } from '@tanstack/react-query';

import { fetchJson } from '@/lib/fetch-json';
import type { BookReport } from '@/lib/paper-desk/report';
import type { EquityPoint } from '@/lib/backtest/types';

export interface PaperDeskBook extends BookReport {
  engineCurve: EquityPoint[];
  executableCurve: EquityPoint[];
}

interface PaperDeskResponse {
  books: PaperDeskBook[];
}

/** The desk advances once a minute, so a two-minute staleness is plenty. */
const STALE_TIME = 120_000;

export function usePaperDesk() {
  return useQuery<PaperDeskResponse>({
    queryKey: ['paperDesk'],
    queryFn: () => fetchJson('/api/admin/paper-desk'),
    staleTime: STALE_TIME,
  });
}
