'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchJson } from '@/lib/fetch-json';
import type {
  AlertListResponse,
  AlertResponse,
  CreateAlertInput,
  UpdateAlertInput,
} from '@/types/alert';

export function useAlerts(status?: string) {
  const url = status ? `/api/alerts?status=${status}` : '/api/alerts';
  return useQuery<AlertListResponse>({
    queryKey: status ? ['alerts', status] : ['alerts'],
    queryFn: () => fetchJson(url),
  });
}

export function useAlert(id: string | null) {
  return useQuery<AlertResponse>({
    queryKey: ['alert', id],
    queryFn: () => fetchJson(`/api/alerts/${id}`),
    enabled: !!id,
  });
}

export function useCreateAlert() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateAlertInput) =>
      fetchJson('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => toast.success('Alert created'),
    onError: (err) => toast.error(err.message || 'Failed to create alert'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
  });
}

export function useUpdateAlert() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: UpdateAlertInput & { id: string }) =>
      fetchJson(`/api/alerts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => toast.success('Alert updated'),
    onError: (err) => toast.error(err.message || 'Failed to update alert'),
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      queryClient.invalidateQueries({ queryKey: ['alert', variables.id] });
    },
  });
}

export function useDeleteAlert() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/alerts/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast.success('Alert deleted'),
    onError: (err) => toast.error(err.message || 'Failed to delete alert'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
  });
}

export function useAcknowledgeAlert() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/alerts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifiedAt: new Date().toISOString() }),
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
  });
}

export function useUnreadAlertCount() {
  const { data } = useAlerts('triggered');
  const unreadCount =
    data?.alerts.filter((a) => !a.notifiedAt).length ?? 0;
  return unreadCount;
}
