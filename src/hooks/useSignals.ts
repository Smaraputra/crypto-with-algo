'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { fetchJson } from '@/lib/fetch-json';
import type { CompositeSignal, SignalComponent, SignalTier } from '@/types/signal';
import type { TradingStyle } from '@/lib/models/signal-template';

interface SignalsResponse {
  signals: Array<CompositeSignal & { _id: string; createdAt: string }>;
}

interface ComputeResponse {
  signal: CompositeSignal & { _id: string };
}

export interface GlobalSignalRecord {
  _id: string;
  symbol: string;
  interval: string;
  tradingStyle: TradingStyle;
  score: number;
  tier: SignalTier;
  confidence: number;
  components: SignalComponent[];
  configVersion: number;
  candleTimestamp: number;
  expiresAt: string;
  createdAt: string;
}

interface GlobalSignalsResponse {
  signals: GlobalSignalRecord[];
}

interface LatestSignalResponse {
  signal: GlobalSignalRecord | null;
}

interface LatestAllSignalsResponse {
  signals: Record<TradingStyle, GlobalSignalRecord | null>;
}

const SIGNAL_STALE_TIME = 60 * 1000; // 1 minute

export function useSignals(
  symbol?: string | null,
  tier?: string | null,
  limit = 50
) {
  const params = new URLSearchParams();
  if (symbol) params.set('symbol', symbol);
  if (tier) params.set('tier', tier);
  params.set('limit', String(limit));

  return useQuery<SignalsResponse>({
    queryKey: ['signals', symbol, tier, limit],
    queryFn: () => fetchJson(`/api/signals?${params}`),
    staleTime: SIGNAL_STALE_TIME,
  });
}

export function useLatestSignal(symbol: string | null) {
  return useQuery<SignalsResponse>({
    queryKey: ['signals', 'latest', symbol],
    queryFn: () => fetchJson(`/api/signals?symbol=${symbol}&limit=1`),
    enabled: !!symbol,
    staleTime: SIGNAL_STALE_TIME,
  });
}

export function useComputeSignal() {
  const queryClient = useQueryClient();

  return useMutation<ComputeResponse, Error, { symbol: string; interval?: string }>({
    mutationFn: (input) =>
      fetchJson('/api/signals/compute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['signals', variables.symbol],
      });
      void queryClient.invalidateQueries({
        queryKey: ['signals', 'latest', variables.symbol],
      });
    },
  });
}

// --- Global signal hooks ---

const GLOBAL_STALE_TIMES: Record<TradingStyle, number> = {
  scalping: 30_000,      // 30s - updates every minute
  day_trading: 120_000,  // 2min - updates every 5min
  swing_trading: 300_000, // 5min - updates every 15min
  position_trading: 600_000, // 10min - updates every hour
};

export function useGlobalSignals(
  symbol: string | null,
  tradingStyle?: TradingStyle | null,
  interval?: string | null,
  limit = 50
) {
  const params = new URLSearchParams();
  if (symbol) params.set('symbol', symbol);
  if (tradingStyle) params.set('tradingStyle', tradingStyle);
  if (interval) params.set('interval', interval);
  params.set('limit', String(limit));

  const staleTime = tradingStyle
    ? GLOBAL_STALE_TIMES[tradingStyle]
    : SIGNAL_STALE_TIME;

  return useQuery<GlobalSignalsResponse>({
    queryKey: ['globalSignals', symbol, tradingStyle, interval, limit],
    queryFn: () => fetchJson(`/api/signals/global?${params}`),
    enabled: !!symbol,
    staleTime,
  });
}

export function useLatestSignals(symbol: string | null) {
  return useQuery<LatestAllSignalsResponse>({
    queryKey: ['globalSignals', 'latest', symbol],
    queryFn: () => fetchJson(`/api/signals/latest?symbol=${symbol}`),
    enabled: !!symbol,
    staleTime: SIGNAL_STALE_TIME,
  });
}

export function useLatestSignalForStyle(
  symbol: string | null,
  tradingStyle: TradingStyle | null
) {
  return useQuery<LatestSignalResponse>({
    queryKey: ['globalSignals', 'latest', symbol, tradingStyle],
    queryFn: () =>
      fetchJson(
        `/api/signals/latest?symbol=${symbol}&tradingStyle=${tradingStyle}`
      ),
    enabled: !!symbol && !!tradingStyle,
    staleTime: tradingStyle ? GLOBAL_STALE_TIMES[tradingStyle] : SIGNAL_STALE_TIME,
  });
}

export function useComputeGlobalSignal() {
  const queryClient = useQueryClient();

  return useMutation<
    ComputeResponse,
    Error,
    { symbol: string; interval?: string; tradingStyle: TradingStyle }
  >({
    mutationFn: (input) =>
      fetchJson('/api/signals/compute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['globalSignals', variables.symbol],
      });
      void queryClient.invalidateQueries({
        queryKey: ['globalSignals', 'latest', variables.symbol],
      });
    },
  });
}
