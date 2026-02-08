'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type {
  PortfolioHistoryResponse,
  CostBasisResponse,
  RiskMetricsResponse,
} from '@/types/analytics';

const STALE_TIME = 5 * 60 * 1000;

export function usePortfolioHistory(portfolioId: string | null, range = 30) {
  return useQuery<PortfolioHistoryResponse>({
    queryKey: ['analytics', 'history', portfolioId, range],
    queryFn: () =>
      fetchJson(`/api/analytics/history?portfolioId=${portfolioId}&range=${range}`),
    enabled: !!portfolioId,
    staleTime: STALE_TIME,
  });
}

export function useCostBasis(portfolioId: string | null) {
  return useQuery<CostBasisResponse>({
    queryKey: ['analytics', 'cost-basis', portfolioId],
    queryFn: () =>
      fetchJson(`/api/analytics/cost-basis?portfolioId=${portfolioId}`),
    enabled: !!portfolioId,
    staleTime: STALE_TIME,
  });
}

export function useRiskMetrics(portfolioId: string | null, range = 90) {
  return useQuery<RiskMetricsResponse>({
    queryKey: ['analytics', 'metrics', portfolioId, range],
    queryFn: () =>
      fetchJson(`/api/analytics/metrics?portfolioId=${portfolioId}&range=${range}`),
    enabled: !!portfolioId,
    staleTime: STALE_TIME,
  });
}
