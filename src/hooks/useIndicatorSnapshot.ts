'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { IndicatorSnapshot } from '@/types/indicator-snapshot';

interface SnapshotResponse {
  snapshot: IndicatorSnapshot;
  symbol: string;
  interval: string;
  candleTimestamp: number;
}

const SNAPSHOT_STALE_TIME_MS = 60_000;

/**
 * The live indicator reading a journal entry can capture.
 *
 * This used to call `/api/signals?symbol=...&limit=1` and rebuild the snapshot
 * in the browser by pulling the first number out of each signal's description
 * text. It took whatever the legacy per-user cron had written last, so the
 * `interval` argument was accepted and then ignored, and most fields came back
 * null or held a different quantity than their name. `/api/indicators/snapshot`
 * computes the reading from the indicators themselves; see
 * `src/lib/indicators/snapshot.ts`.
 */
export function useIndicatorSnapshot(symbol: string | null, interval: string = '1h') {
  return useQuery<IndicatorSnapshot | null>({
    queryKey: ['indicator-snapshot', symbol, interval],
    queryFn: async () => {
      if (!symbol) return null;
      const data: SnapshotResponse = await fetchJson(
        `/api/indicators/snapshot?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`
      );
      return data.snapshot ?? null;
    },
    enabled: !!symbol,
    staleTime: SNAPSHOT_STALE_TIME_MS,
  });
}
