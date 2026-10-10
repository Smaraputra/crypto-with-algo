'use client';

import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';

import { fetchJson } from '@/lib/fetch-json';
import { intervalToMs } from '@/lib/intervals';
import type { TradingStyle } from '@/lib/models/signal-template';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { callMarks, chunkRange, chunkStarts, type CallMark } from '@/lib/signals/track-record/chart-data';
import {
  trackRecordCell,
  type TrackBar,
  type TrackBarsResponse,
  type TrackRecordResponse,
} from '@/lib/signals/track-record/types';

/**
 * Read-only hooks for the track record: the summary of one symbol in one cell,
 * and the scored bars for whatever range the chart has loaded, fetched in
 * aligned chunks so scrolling back reuses earlier pages.
 */

const SUMMARY_STALE_MS = 5 * 60_000;
/** The newest chunk picks up resolving outcomes; older chunks change only while their last live calls resolve. */
const LIVE_CHUNK_REFETCH_MS = 5 * 60_000;
const OLDER_CHUNK_STALE_MS = 30 * 60_000;

export function isTrackRecordEligible(symbol: string, interval: string, style: TradingStyle | null): boolean {
  return (SIGNAL_SYMBOLS as readonly string[]).includes(symbol) && trackRecordCell(style, interval) !== null;
}

export function useTrackRecord(symbol: string, interval: string, style: TradingStyle | null) {
  const eligible = isTrackRecordEligible(symbol, interval, style);
  return useQuery<TrackRecordResponse>({
    queryKey: ['trackRecord', symbol, interval, style],
    queryFn: () => {
      const params = new URLSearchParams({ symbol, interval, style: style ?? '' });
      return fetchJson(`/api/signals/track-record?${params}`);
    },
    enabled: eligible,
    staleTime: SUMMARY_STALE_MS,
  });
}

export interface TrackBarsState {
  /** Every fetched bar keyed by open time: the score pane draws them. */
  bars: ReadonlyMap<number, TrackBar>;
  /** The directional ones, with outcomes: the price pane marks them. */
  calls: ReadonlyMap<number, CallMark>;
  boundary: number | null;
  /** Scorer version of the run and of its live bars. */
  configVersion: number | null;
  horizonBars: number;
  costPercent: number;
  loading: boolean;
  error: boolean;
}

const EMPTY_BARS: ReadonlyMap<number, TrackBar> = new Map();
const EMPTY_CALLS: ReadonlyMap<number, CallMark> = new Map();

/**
 * Bars for the loaded chart range [from, to]. The chart reports `to` as its
 * newest bar, the forming one, so the last chunk is the live one: it alone is
 * refetched, picking up outcomes as they resolve.
 */
export function useTrackRecordBars(
  symbol: string,
  interval: string,
  style: TradingStyle | null,
  range: { from: number; to: number } | null
): TrackBarsState {
  const eligible = isTrackRecordEligible(symbol, interval, style) && range !== null;
  const intervalMs = eligible ? intervalToMs(interval) : 0;
  const starts = eligible && range ? chunkStarts(range.from, range.to, intervalMs) : [];
  const newest = starts[starts.length - 1];

  const results = useQueries({
    queries: starts.map((start) => {
      const { from, to } = chunkRange(start, intervalMs);
      return {
        queryKey: ['trackRecordBars', symbol, interval, style, start],
        queryFn: () => {
          const params = new URLSearchParams({ symbol, interval, style: style ?? '', from: String(from), to: String(to) });
          return fetchJson<TrackBarsResponse>(`/api/signals/track-record/bars?${params}`);
        },
        staleTime: start === newest ? LIVE_CHUNK_REFETCH_MS : OLDER_CHUNK_STALE_MS,
        refetchInterval: start === newest ? LIVE_CHUNK_REFETCH_MS : (false as const),
      };
    }),
  });

  const dataStamp = results.map((r) => r.dataUpdatedAt).join(',');
  const merged = useMemo(() => {
    const bars = new Map<number, TrackBar>();
    let meta: TrackBarsResponse | null = null;
    for (const r of results) {
      if (!r.data) continue;
      if (r.data.available) meta = r.data;
      for (const bar of r.data.bars) bars.set(bar.t, bar);
    }
    return { bars, meta };
    // dataStamp changes exactly when any chunk's data does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataStamp]);

  const calls = useMemo(
    () => (merged.meta ? callMarks(merged.bars.values(), merged.meta.costPercent) : EMPTY_CALLS),
    [merged]
  );

  if (!eligible) {
    return {
      bars: EMPTY_BARS,
      calls: EMPTY_CALLS,
      boundary: null,
      configVersion: null,
      horizonBars: 0,
      costPercent: 0,
      loading: false,
      error: false,
    };
  }
  return {
    bars: merged.bars,
    calls,
    boundary: merged.meta?.boundary ?? null,
    configVersion: merged.meta?.configVersion ?? null,
    horizonBars: merged.meta?.horizonBars ?? 0,
    costPercent: merged.meta?.costPercent ?? 0,
    loading: results.some((r) => r.isPending),
    error: results.some((r) => r.isError),
  };
}
