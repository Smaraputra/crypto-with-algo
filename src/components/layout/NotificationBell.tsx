'use client';

import { Bell, X } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useAlerts, useUnreadAlertCount, useAcknowledgeAlert } from '@/hooks/useAlerts';
import type { Alert } from '@/types/alert';

function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const diff = now - new Date(date).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function describeAlert(alert: Alert): string {
  switch (alert.type) {
    case 'price_above':
      return `${alert.symbol} above $${alert.targetPrice?.toLocaleString()}`;
    case 'price_below':
      return `${alert.symbol} below $${alert.targetPrice?.toLocaleString()}`;
    case 'price_change_pct':
      return `${alert.symbol} changed ${alert.percentChange}%`;
    case 'portfolio_value_above':
      return `Portfolio above $${alert.targetPrice?.toLocaleString()}`;
    case 'portfolio_value_below':
      return `Portfolio below $${alert.targetPrice?.toLocaleString()}`;
    case 'holding_change_pct':
      return `${alert.symbol} P&L ${alert.percentChange}%`;
    default:
      return 'Alert triggered';
  }
}

export function NotificationBell() {
  const unreadCount = useUnreadAlertCount();
  const { data } = useAlerts('triggered');
  const acknowledgeAlert = useAcknowledgeAlert();

  const unreadAlerts = (data?.alerts ?? []).filter((a) => !a.notifiedAt);

  const handleDismiss = (id: string) => {
    acknowledgeAlert.mutate(id);
  };

  const handleMarkAllRead = () => {
    for (const alert of unreadAlerts) {
      acknowledgeAlert.mutate(alert._id);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-bearish px-1 text-xs font-bold text-white"
              data-testid="notification-badge"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-medium">Notifications</span>
          {unreadAlerts.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-1 text-xs"
              onClick={handleMarkAllRead}
            >
              Mark All Read
            </Button>
          )}
        </div>

        <div className="max-h-64 overflow-y-auto" aria-live="polite">
          {unreadAlerts.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              No new notifications
            </div>
          ) : (
            unreadAlerts.map((alert) => (
              <div
                key={alert._id}
                className="flex items-start justify-between border-b border-border/50 px-3 py-2 last:border-b-0"
              >
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">
                    {describeAlert(alert)}
                  </p>
                  {alert.triggeredAt && (
                    <p className="text-xs text-muted-foreground">
                      {formatTimeAgo(alert.triggeredAt)}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0"
                  onClick={() => handleDismiss(alert._id)}
                  aria-label="Dismiss"
                >
                  <X className="size-3" />
                </Button>
              </div>
            ))
          )}
        </div>

        <div className="border-t border-border px-3 py-2">
          <Link
            href="/alerts?status=triggered"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            View All Alerts
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
