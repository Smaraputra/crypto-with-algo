'use client';

import React from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useAlerts, useUnreadAlertCount, useAcknowledgeAlert } from '@/hooks/useAlerts';
import { cn } from '@/lib/utils';
import type { Alert } from '@/types/alert';

function formatAlertCondition(alert: Alert): string {
  if (alert.message) return alert.message;
  const typeLabel = alert.type.replace(/_/g, ' ');
  const value = alert.targetPrice ?? alert.percentChange ?? '';
  return `${typeLabel} ${value}`.trim();
}

function formatAlertTime(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function AlertsBell() {
  const unreadCount = useUnreadAlertCount();
  const { data, isLoading, isError, refetch } = useAlerts('triggered');
  const acknowledgeAlert = useAcknowledgeAlert();

  const alerts = data?.alerts ?? [];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Alerts"
          className={cn(
            'relative flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[10px] text-ink-2 select-none',
            'transition-colors duration-120 hover:bg-muted hover:text-foreground',
            'active:scale-[0.98] motion-reduce:active:scale-100',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
          )}
        >
          <Bell className="size-5" />
          {unreadCount > 0 && (
            <span
              data-testid="alerts-badge"
              className="absolute top-1.5 right-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-foreground px-1 text-[10px] font-bold text-background leading-none select-none"
            >
              {unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3 shadow-md">
        <div className="mb-2 flex items-center justify-between border-b border-line pb-2">
          <span className="font-semibold text-foreground text-sm">Triggered alerts</span>
        </div>

        {isLoading && (
          <p className="py-6 text-center text-sm text-ink-2">Loading alerts.</p>
        )}

        {isError && (
          <div className="py-6 text-center text-sm">
            <p className="text-destructive">Alerts did not load.</p>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-2 inline-flex min-h-[44px] items-center text-xs font-semibold text-foreground underline underline-offset-4 cursor-pointer"
            >
              Try again
            </button>
          </div>
        )}

        {!isLoading && !isError && alerts.length === 0 && (
          <p className="py-6 text-center text-sm text-ink-2">No triggered alerts.</p>
        )}

        {!isLoading && !isError && alerts.length > 0 && (
          <ul className="max-h-64 divide-y divide-line overflow-y-auto">
            {alerts.map((alert) => (
              <li
                key={alert._id}
                className="flex items-center justify-between gap-2 py-2.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground">{alert.symbol}</span>
                    <span className="text-muted-foreground">{formatAlertTime(alert.triggeredAt ?? alert.updatedAt)}</span>
                  </div>
                  <p className="truncate text-ink-2">{formatAlertCondition(alert)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => acknowledgeAlert.mutate(alert._id)}
                  className={cn(
                    'inline-flex min-h-[36px] cursor-pointer items-center rounded-md border border-edge px-2.5 text-xs font-semibold text-foreground',
                    'hover:bg-muted active:scale-[0.98] motion-reduce:active:scale-100',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                  )}
                >
                  Acknowledge
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2 border-t border-line pt-2 text-center">
          <Link
            href="/alerts"
            className="inline-flex min-h-[44px] items-center text-xs font-semibold text-foreground hover:underline"
          >
            All alerts
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
