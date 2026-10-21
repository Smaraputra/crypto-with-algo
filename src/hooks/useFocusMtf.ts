'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { MtfInterval, MtfState } from '@/lib/market/mtf';
import type { PriorDayLevels } from '@/lib/market/levels';

export interface MtfIntervalError {
  interval: MtfInterval;
  error: true;
}

export type FocusMtfRow = MtfState | MtfIntervalError;
export type MtfRowState = FocusMtfRow;

export interface FocusMtfResponse {
  symbol: string;
  states: FocusMtfRow[];
  priorDay: PriorDayLevels | null;
}

export function useFocusMtf(symbol: string) {
  return useQuery<FocusMtfResponse>({
    queryKey: ['focus', 'mtf', symbol],
    queryFn: () =>
      fetchJson<FocusMtfResponse>(
        '/api/focus/mtf?symbol=' + encodeURIComponent(symbol)
      ),
    enabled: Boolean(symbol),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
