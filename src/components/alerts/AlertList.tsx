'use client';

import { Bell, Pause, Play, Trash2, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useUpdateAlert, useDeleteAlert, useAcknowledgeAlert } from '@/hooks/useAlerts';
import type { Alert, AlertType } from '@/types/alert';

function describeAlert(alert: Alert): string {
  switch (alert.type) {
    case 'price_above':
      return `${alert.symbol} price above $${alert.targetPrice?.toLocaleString()}`;
    case 'price_below':
      return `${alert.symbol} price below $${alert.targetPrice?.toLocaleString()}`;
    case 'price_change_pct':
      return `${alert.symbol} changes by ${alert.percentChange}%`;
    case 'portfolio_value_above':
      return `Portfolio value above $${alert.targetPrice?.toLocaleString()}`;
    case 'portfolio_value_below':
      return `Portfolio value below $${alert.targetPrice?.toLocaleString()}`;
    case 'holding_change_pct':
      return `${alert.symbol} P&L changes by ${alert.percentChange}%`;
    default:
      return 'Unknown alert type';
  }
}

function typeLabel(type: AlertType): string {
  const labels: Record<AlertType, string> = {
    price_above: 'Price Above',
    price_below: 'Price Below',
    price_change_pct: 'Price % Change',
    portfolio_value_above: 'Portfolio Above',
    portfolio_value_below: 'Portfolio Below',
    holding_change_pct: 'Holding % Change',
  };
  return labels[type];
}

function StatusBadge({ status }: { status: Alert['status'] }) {
  const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> =
    {
      active: 'default',
      triggered: 'outline',
      paused: 'secondary',
    };
  const colors: Record<string, string> = {
    active: 'bg-bullish text-white hover:bg-bullish/80',
    triggered: 'border-accent text-accent',
    paused: '',
  };

  return (
    <Badge variant={variants[status]} className={colors[status]}>
      {status}
    </Badge>
  );
}

interface AlertListProps {
  alerts: Alert[];
  isLoading: boolean;
}

export function AlertList({ alerts, isLoading }: AlertListProps) {
  const updateAlert = useUpdateAlert();
  const deleteAlert = useDeleteAlert();
  const acknowledgeAlert = useAcknowledgeAlert();

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="alert-list-loading">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  if (alerts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center" data-testid="alert-list-empty">
        <Bell className="mb-3 size-10 text-muted-foreground/50" />
        <p className="text-sm font-medium text-muted-foreground">
          No alerts yet
        </p>
        <p className="text-xs text-muted-foreground/70">
          Create an alert to get notified about market conditions
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="alert-list">
      {alerts.map((alert) => (
        <div
          key={alert._id}
          className="flex items-center justify-between rounded-lg border border-border bg-card p-3"
          data-testid={`alert-item-${alert._id}`}
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                {describeAlert(alert)}
              </span>
              <StatusBadge status={alert.status} />
              {alert.recurring && (
                <Badge variant="outline" className="text-[10px]">
                  recurring
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{typeLabel(alert.type)}</span>
              {alert.message && (
                <>
                  <span>-</span>
                  <span>{alert.message}</span>
                </>
              )}
              <span>-</span>
              <span>{new Date(alert.createdAt).toLocaleDateString()}</span>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {alert.status === 'triggered' && !alert.notifiedAt && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => acknowledgeAlert.mutate(alert._id)}
                title="Acknowledge"
                aria-label="Acknowledge"
              >
                <Check className="size-4 text-bullish" />
              </Button>
            )}

            {alert.status !== 'triggered' && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() =>
                  updateAlert.mutate({
                    id: alert._id,
                    status: alert.status === 'active' ? 'paused' : 'active',
                  })
                }
                title={alert.status === 'active' ? 'Pause' : 'Resume'}
                aria-label={alert.status === 'active' ? 'Pause' : 'Resume'}
              >
                {alert.status === 'active' ? (
                  <Pause className="size-4" />
                ) : (
                  <Play className="size-4" />
                )}
              </Button>
            )}

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive hover:text-destructive"
                  title="Delete"
                  aria-label="Delete"
                >
                  <Trash2 className="size-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Alert</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete this alert? This action
                    cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => deleteAlert.mutate(alert._id)}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      ))}
    </div>
  );
}
