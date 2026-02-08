'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  PortfolioListResponse,
  PortfolioResponse,
  AddHoldingInput,
  RecordTransactionInput,
} from '@/types/portfolio';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }
  return res.json();
}

export function usePortfolios() {
  return useQuery<PortfolioListResponse>({
    queryKey: ['portfolios'],
    queryFn: () => fetchJson('/api/portfolio'),
  });
}

export function usePortfolio(id: string | null) {
  return useQuery<PortfolioResponse>({
    queryKey: ['portfolio', id],
    queryFn: () => fetchJson(`/api/portfolio/${id}`),
    enabled: !!id,
  });
}

export function useCreatePortfolio() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: string) =>
      fetchJson('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => toast.success('Portfolio created'),
    onError: (err) => toast.error(err.message || 'Failed to create portfolio'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    },
  });
}

export function useRenamePortfolio() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      fetchJson(`/api/portfolio/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => toast.success('Portfolio renamed'),
    onError: (err) => toast.error(err.message || 'Failed to rename portfolio'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    },
  });
}

export function useDeletePortfolio() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/portfolio/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast.success('Portfolio deleted'),
    onError: (err) => toast.error(err.message || 'Failed to delete portfolio'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    },
  });
}

export function useAddHolding(portfolioId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AddHoldingInput) =>
      fetchJson(`/api/portfolio/${portfolioId}/holdings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => toast.success('Holding added'),
    onError: (err) => toast.error(err.message || 'Failed to add holding'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolio', portfolioId] });
      queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    },
  });
}

export function useRemoveHolding(portfolioId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (symbol: string) =>
      fetchJson(`/api/portfolio/${portfolioId}/holdings/${symbol}`, {
        method: 'DELETE',
      }),
    onSuccess: () => toast.success('Holding removed'),
    onError: (err) => toast.error(err.message || 'Failed to remove holding'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolio', portfolioId] });
      queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    },
  });
}

export function useRecordTransaction(portfolioId: string, symbol: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: RecordTransactionInput) =>
      fetchJson(
        `/api/portfolio/${portfolioId}/holdings/${symbol}/transactions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }
      ),
    onSuccess: () => toast.success('Transaction recorded'),
    onError: (err) => toast.error(err.message || 'Failed to record transaction'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolio', portfolioId] });
      queryClient.invalidateQueries({
        queryKey: ['transactions', portfolioId, symbol],
      });
    },
  });
}

export function useTransactions(portfolioId: string, symbol: string) {
  return useQuery({
    queryKey: ['transactions', portfolioId, symbol],
    queryFn: () =>
      fetchJson(
        `/api/portfolio/${portfolioId}/holdings/${symbol}/transactions`
      ),
    enabled: !!portfolioId && !!symbol,
  });
}
