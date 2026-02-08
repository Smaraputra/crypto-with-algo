'use client';

import { useQuery, useMutation } from '@tanstack/react-query';
import { useCallback } from 'react';
import { fetchJson } from '@/lib/fetch-json';
import type {
  PortfolioHistoryResponse,
  CostBasisResponse,
  RiskMetricsResponse,
  CostBasisMethod,
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

export function useCostBasis(portfolioId: string | null, method: CostBasisMethod = 'fifo') {
  return useQuery<CostBasisResponse>({
    queryKey: ['analytics', 'cost-basis', portfolioId, method],
    queryFn: () =>
      fetchJson(`/api/analytics/cost-basis?portfolioId=${portfolioId}&method=${method}`),
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

export interface ExportCsvOptions {
  year?: number;
  method?: CostBasisMethod;
}

export function useExportCsv(portfolioId: string | null) {
  const downloadCsv = useCallback(
    async (opts?: ExportCsvOptions) => {
      if (!portfolioId) return;
      const params = new URLSearchParams({ portfolioId });
      if (opts?.year) params.set('year', String(opts.year));
      if (opts?.method) params.set('method', opts.method);

      const res = await fetch(`/api/analytics/export?${params}`);
      if (!res.ok) throw new Error('Export failed');

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = opts?.year ? `tax-report-${opts.year}.csv` : 'tax-report.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [portfolioId]
  );

  return useMutation({
    mutationFn: downloadCsv,
  });
}
