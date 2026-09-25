'use client';

import { useQuery } from '@tanstack/react-query';

import { fetchJson } from '@/lib/fetch-json';
import type { CalibrationResponse } from '@/types/calibration';
import type { TradingStyle } from '@/lib/models/signal-template';

export interface CalibrationQuery {
  style: TradingStyle;
  interval: string;
  source: 'composite' | 'llm';
  symbol?: string;
  configVersion?: number;
  overlapping?: boolean;
}

/**
 * The calibration record for one style, interval and source.
 *
 * staleTime matches the route's own Redis TTL: the outcome resolver writes
 * every 15 minutes, so a shorter client window would only re-fetch the same
 * cached payload. There is no refetchInterval for the same reason -- this is a
 * record being read, not a live price.
 */
export function useCalibration(query: CalibrationQuery) {
  const params = new URLSearchParams({
    style: query.style,
    interval: query.interval,
    source: query.source,
  });
  if (query.symbol) params.set('symbol', query.symbol);
  if (query.configVersion !== undefined) params.set('configVersion', String(query.configVersion));
  if (query.overlapping) params.set('overlapping', 'true');

  return useQuery({
    queryKey: ['calibration', params.toString()],
    queryFn: () => fetchJson<CalibrationResponse>(`/api/admin/calibration?${params.toString()}`),
    staleTime: 300_000,
  });
}
