'use client';

import { useQuery } from '@tanstack/react-query';

import { fetchJson } from '@/lib/fetch-json';
import type {
  FundingRate,
  LongShortRatio,
  OpenInterest,
  OpenInterestHist,
} from '@/types/futures';

interface FundingRateResponse {
  fundingRates: FundingRate[];
}

interface OpenInterestResponse {
  openInterest: OpenInterest;
  history: OpenInterestHist[] | null;
}

interface LongShortResponse {
  longShortRatio: LongShortRatio[];
}

const FUTURES_STALE_TIME = 30 * 1000; // 30 seconds

export function useFundingRate(symbol: string | null, limit = 1) {
  return useQuery<FundingRateResponse>({
    queryKey: ['futures', 'funding', symbol, limit],
    queryFn: () =>
      fetchJson(`/api/futures/funding?symbol=${symbol}&limit=${limit}`),
    enabled: !!symbol,
    staleTime: FUTURES_STALE_TIME,
  });
}

export function useOpenInterest(
  symbol: string | null,
  includeHistory = false
) {
  return useQuery<OpenInterestResponse>({
    queryKey: ['futures', 'oi', symbol, includeHistory],
    queryFn: () =>
      fetchJson(
        `/api/futures/open-interest?symbol=${symbol}${includeHistory ? '&history=true' : ''}`
      ),
    enabled: !!symbol,
    staleTime: FUTURES_STALE_TIME,
  });
}

export function useLongShortRatio(
  symbol: string | null,
  period = '1h',
  type: 'top' | 'global' = 'top'
) {
  return useQuery<LongShortResponse>({
    queryKey: ['futures', 'ls', symbol, period, type],
    queryFn: () =>
      fetchJson(
        `/api/futures/long-short?symbol=${symbol}&period=${period}&type=${type}`
      ),
    enabled: !!symbol,
    staleTime: FUTURES_STALE_TIME,
  });
}
