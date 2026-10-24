'use client';

import { useCallback, useMemo, useState } from 'react';
import type { CallsOverlay, TimeRange } from '@/components/chart/useTradingChartEngine';
import { isTrackRecordEligible, useTrackRecordBars } from '@/hooks/useTrackRecord';
import { resolveStyle } from '@/lib/signals/provisional/styles';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { viewTally, type ViewTally } from '@/lib/signals/track-record/chart-data';

export interface ChartCalls {
  /** The chart can show calls: a signal coin at a recorded interval. */
  eligible: boolean;
  /** Why not, when not eligible. */
  ineligibleReason: 'symbol' | 'interval' | null;
  show: boolean;
  setShow: (next: boolean) => void;
  /** Pass straight to useTradingChartEngine. */
  callsOverlay: CallsOverlay;
  onLoadedRangeChange: (range: TimeRange) => void;
  onVisibleRangeChange: (range: TimeRange) => void;
  /** Calls inside the visible window; null until a window and the bars are known. */
  tally: ViewTally | null;
  loading: boolean;
  error: boolean;
}

export function useChartCalls(symbol: string, interval: string): ChartCalls {
  const style = resolveStyle(interval);
  const inSymbols = (SIGNAL_SYMBOLS as readonly string[]).includes(symbol);
  const eligibleForTrackRecord = isTrackRecordEligible(symbol, interval, style);
  const ineligibleReason: 'symbol' | 'interval' | null = !inSymbols
    ? 'symbol'
    : !eligibleForTrackRecord
      ? 'interval'
      : null;
  const eligible = ineligibleReason === null;

  const [show, setShow] = useState<boolean>(true);

  const key = `${symbol}|${interval}`;
  const [loaded, setLoaded] = useState<{ key: string; range: TimeRange } | null>(null);
  const loadedRange = loaded?.key === key ? loaded.range : null;

  const [visible, setVisible] = useState<{ key: string; range: TimeRange } | null>(null);
  const visibleRange = visible?.key === key ? visible.range : null;

  const onLoadedRangeChange = useCallback(
    (range: TimeRange) => {
      setLoaded({ key, range });
    },
    [key]
  );

  const onVisibleRangeChange = useCallback(
    (range: TimeRange) => {
      setVisible({ key, range });
    },
    [key]
  );

  const track = useTrackRecordBars(symbol, interval, style, loadedRange);

  const callsOverlay: CallsOverlay = useMemo(
    () => ({
      visible: eligible && show,
      calls: track.calls,
      boundary: track.boundary,
      horizonBars: track.horizonBars,
      costPercent: track.costPercent,
    }),
    [eligible, show, track.calls, track.boundary, track.horizonBars, track.costPercent]
  );

  const tally = useMemo(() => {
    if (!visibleRange || track.loading || track.error) return null;
    return viewTally(track.calls, visibleRange.from, visibleRange.to);
  }, [visibleRange, track.loading, track.error, track.calls]);

  return {
    eligible,
    ineligibleReason,
    show,
    setShow,
    callsOverlay,
    onLoadedRangeChange,
    onVisibleRangeChange,
    tally,
    loading: track.loading,
    error: track.error,
  };
}
