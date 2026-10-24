'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StateNotice } from '@/components/kit/StateNotice';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useTickers } from '@/hooks/usePrices';
import {
  useAcknowledgeAlert,
  useDeleteAlert,
  useUpdateAlert,
} from '@/hooks/useAlerts';
import { cn } from '@/lib/utils';
import type { Alert, AlertStatus, AlertType } from '@/types/alert';

export function formatCurrency(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return 'n/a';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(val) ? 0 : 2,
    maximumFractionDigits: val < 1 ? 4 : 2,
  }).format(val);
}

export function formatDate(val: Date | string | null | undefined): string {
  if (!val) return 'n/a';
  const d = new Date(val);
  if (isNaN(d.getTime())) return 'n/a';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function getBaseAsset(symbol?: string | null): string {
  if (!symbol) return 'n/a';
  return symbol.replace(/(USDT|USDC|BUSD)$/, '') || symbol;
}

export function formatAlertCondition(alert: {
  type: AlertType;
  targetPrice?: number | null;
  percentChange?: number | null;
  referencePrice?: number | null;
  symbol?: string | null;
}): string {
  const base = getBaseAsset(alert.symbol);
  const target = formatCurrency(alert.targetPrice);
  const p =
    alert.percentChange !== null && alert.percentChange !== undefined
      ? Math.abs(alert.percentChange)
      : 'n/a';

  switch (alert.type) {
    case 'price_above':
      return `${base} at or above ${target}`;
    case 'price_below':
      return `${base} at or below ${target}`;
    case 'price_change_pct': {
      if (alert.referencePrice !== null && alert.referencePrice !== undefined) {
        return `${base} moves ${p}% either way from ${formatCurrency(alert.referencePrice)}`;
      }
      return `${base} moves ${p}% either way (no starting price, so this alert cannot fire; delete and recreate it)`;
    }
    case 'holding_change_pct':
      return `${base} moves ${p}% either way from your average cost`;
    case 'portfolio_value_above':
      return `Portfolio value at or above ${target}`;
    case 'portfolio_value_below':
      return `Portfolio value at or below ${target}`;
    default:
      return 'Alert condition';
  }
}

export function formatStatusLabel(status: AlertStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'triggered':
      return 'Triggered';
    case 'paused':
      return 'Paused';
    default:
      return status;
  }
}

export interface AlertListProps {
  alerts?: Alert[];
  isLoading?: boolean;
  isError?: boolean;
  onRefetch?: () => void;
  className?: string;
}

export const AlertList: React.FC<AlertListProps> = ({
  alerts = [],
  isLoading = false,
  isError = false,
  onRefetch,
  className,
}) => {
  const [alertToDelete, setAlertToDelete] = useState<Alert | null>(null);

  const acknowledgeMutation = useAcknowledgeAlert();
  const updateMutation = useUpdateAlert();
  const deleteMutation = useDeleteAlert();

  const symbols = useMemo(() => {
    return Array.from(new Set(alerts.map((a) => a.symbol).filter(Boolean)));
  }, [alerts]);

  const { tickers: binanceTickers } = useBinanceTicker(symbols);
  const { data: restTickers } = useTickers();

  const getPrice = (symbol?: string): number | null => {
    if (!symbol) return null;
    const binance = binanceTickers[symbol];
    if (binance?.lastPrice) {
      const p = parseFloat(binance.lastPrice);
      if (!isNaN(p)) return p;
    }
    const rest = restTickers?.find((t) => t.symbol === symbol);
    if (rest?.lastPrice) {
      const p = parseFloat(rest.lastPrice);
      if (!isNaN(p)) return p;
    }
    return null;
  };

  const handleConfirmDelete = () => {
    if (!alertToDelete) return;
    deleteMutation.mutate(alertToDelete._id, {
      onSuccess: () => setAlertToDelete(null),
    });
  };

  if (isLoading) {
    return (
      <div className={className}>
        <StateNotice
          kind="loading"
          title="Loading alerts"
          description="Fetching your price conditions..."
        />
      </div>
    );
  }

  if (isError) {
    return (
      <div className={className}>
        <StateNotice
          kind="error"
          title="Alerts did not load."
          action={
            <Button
              type="button"
              variant="outline"
              onClick={onRefetch}
              className="min-h-[44px] rounded-[12px] px-4"
            >
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  if (alerts.length === 0) {
    return (
      <div className={className}>
        <StateNotice
          kind="empty"
          title="No alerts yet."
          description="Create one to be told when a price moves."
        />
      </div>
    );
  }

  return (
    <div className={cn('space-y-4', className)}>
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto rounded-[14px] border border-edge bg-card">
        <table className="w-full text-left text-[14px]">
          <thead>
            <tr className="border-b border-line text-muted-foreground text-[12px]">
              <th className="py-3.5 px-4 font-medium">Coin</th>
              <th className="py-3.5 px-4 font-medium">Condition</th>
              <th className="py-3.5 px-4 font-medium">Current price</th>
              <th className="py-3.5 px-4 font-medium">Status</th>
              <th className="py-3.5 px-4 font-medium">Created</th>
              <th className="py-3.5 px-4 font-medium">Triggered</th>
              <th className="py-3.5 px-4 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {alerts.map((alert) => {
              const baseAsset = getBaseAsset(alert.symbol);
              const condition = formatAlertCondition(alert);
              const currentPrice = getPrice(alert.symbol);
              const statusLabel = formatStatusLabel(alert.status);
              const createdDate = formatDate(alert.createdAt);
              const triggeredDate = formatDate(
                alert.triggeredAt || alert.lastTriggeredAt
              );

              return (
                <tr
                  key={alert._id}
                  data-testid={`alert-row-${alert._id}`}
                  className="hover:bg-muted/40 transition-colors"
                >
                  <td className="py-3.5 px-4">
                    {alert.symbol ? (
                      <Link
                        href={`/focus?symbol=${encodeURIComponent(alert.symbol)}`}
                        className="font-semibold text-foreground hover:underline focus-visible:outline-3 focus-visible:outline-ring rounded-[4px]"
                      >
                        {baseAsset}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{baseAsset}</span>
                    )}
                  </td>
                  <td className="py-3.5 px-4 text-foreground font-medium">
                    {condition}
                  </td>
                  <td className="py-3.5 px-4 font-sans tabular-nums text-foreground">
                    {currentPrice !== null ? (
                      formatCurrency(currentPrice)
                    ) : (
                      <span className="text-muted-foreground">n/a</span>
                    )}
                  </td>
                  <td className="py-3.5 px-4">
                    <span
                      className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-[6px] text-[12px] font-semibold select-none',
                        alert.status === 'triggered' &&
                          'bg-brand/15 text-brand-line dark:text-brand',
                        alert.status === 'active' && 'bg-muted text-foreground',
                        alert.status === 'paused' &&
                          'bg-muted/60 text-muted-foreground'
                      )}
                    >
                      {statusLabel}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 font-sans tabular-nums text-[13px] text-muted-foreground">
                    {createdDate}
                  </td>
                  <td className="py-3.5 px-4 font-sans tabular-nums text-[13px] text-muted-foreground">
                    {triggeredDate}
                  </td>
                  <td className="py-3.5 px-4 text-right">
                    <div className="inline-flex items-center gap-2 justify-end">
                      {alert.status === 'triggered' && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={acknowledgeMutation.isPending}
                          onClick={() => acknowledgeMutation.mutate(alert._id)}
                          className="min-h-[44px] px-3 rounded-[12px] text-[13px] font-medium"
                        >
                          Acknowledge
                        </Button>
                      )}
                      {alert.status === 'active' && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={updateMutation.isPending}
                          onClick={() =>
                            updateMutation.mutate({
                              id: alert._id,
                              status: 'paused',
                            })
                          }
                          className="min-h-[44px] px-3 rounded-[12px] text-[13px] font-medium"
                        >
                          Pause
                        </Button>
                      )}
                      {alert.status === 'paused' && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={updateMutation.isPending}
                          onClick={() =>
                            updateMutation.mutate({
                              id: alert._id,
                              status: 'active',
                            })
                          }
                          className="min-h-[44px] px-3 rounded-[12px] text-[13px] font-medium"
                        >
                          Resume
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setAlertToDelete(alert)}
                        className="min-h-[44px] px-3 rounded-[12px] text-[13px] font-medium text-down hover:text-down hover:bg-down/10"
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked list */}
      <div className="md:hidden space-y-3">
        {alerts.map((alert) => {
          const baseAsset = getBaseAsset(alert.symbol);
          const condition = formatAlertCondition(alert);
          const currentPrice = getPrice(alert.symbol);
          const statusLabel = formatStatusLabel(alert.status);
          const createdDate = formatDate(alert.createdAt);
          const triggeredDate = formatDate(
            alert.triggeredAt || alert.lastTriggeredAt
          );

          return (
            <div
              key={alert._id}
              data-testid={`alert-card-${alert._id}`}
              className="rounded-[14px] border border-edge bg-card p-4 space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  {alert.symbol ? (
                    <Link
                      href={`/focus?symbol=${encodeURIComponent(alert.symbol)}`}
                      className="font-semibold text-[16px] text-foreground hover:underline focus-visible:outline-3 focus-visible:outline-ring rounded-[4px]"
                    >
                      {baseAsset}
                    </Link>
                  ) : (
                    <span className="font-semibold text-[16px] text-muted-foreground">
                      {baseAsset}
                    </span>
                  )}
                </div>
                <span
                  className={cn(
                    'inline-flex items-center px-2 py-0.5 rounded-[6px] text-[12px] font-semibold select-none',
                    alert.status === 'triggered' &&
                      'bg-brand/15 text-brand-line dark:text-brand',
                    alert.status === 'active' && 'bg-muted text-foreground',
                    alert.status === 'paused' &&
                      'bg-muted/60 text-muted-foreground'
                  )}
                >
                  {statusLabel}
                </span>
              </div>

              <div className="text-[14px] font-medium text-foreground">
                {condition}
              </div>

              <div className="grid grid-cols-2 gap-2 text-[13px] pt-1 border-t border-line">
                <div>
                  <span className="text-muted-foreground block text-[11px]">
                    Current price
                  </span>
                  <span className="font-sans tabular-nums text-foreground font-medium">
                    {currentPrice !== null ? (
                      formatCurrency(currentPrice)
                    ) : (
                      <span className="text-muted-foreground">n/a</span>
                    )}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-[11px]">
                    Created
                  </span>
                  <span className="font-sans tabular-nums text-muted-foreground">
                    {createdDate}
                  </span>
                </div>
                {triggeredDate !== 'n/a' && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground block text-[11px]">
                      Triggered
                    </span>
                    <span className="font-sans tabular-nums text-muted-foreground">
                      {triggeredDate}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-line justify-end">
                {alert.status === 'triggered' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={acknowledgeMutation.isPending}
                    onClick={() => acknowledgeMutation.mutate(alert._id)}
                    className="min-h-[44px] px-3 rounded-[12px] text-[13px] font-medium"
                  >
                    Acknowledge
                  </Button>
                )}
                {alert.status === 'active' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={updateMutation.isPending}
                    onClick={() =>
                      updateMutation.mutate({
                        id: alert._id,
                        status: 'paused',
                      })
                    }
                    className="min-h-[44px] px-3 rounded-[12px] text-[13px] font-medium"
                  >
                    Pause
                  </Button>
                )}
                {alert.status === 'paused' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={updateMutation.isPending}
                    onClick={() =>
                      updateMutation.mutate({
                        id: alert._id,
                        status: 'active',
                      })
                    }
                    className="min-h-[44px] px-3 rounded-[12px] text-[13px] font-medium"
                  >
                    Resume
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setAlertToDelete(alert)}
                  className="min-h-[44px] px-3 rounded-[12px] text-[13px] font-medium text-down hover:text-down hover:bg-down/10"
                >
                  Delete
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* In-UI delete confirmation dialog */}
      <Dialog
        open={!!alertToDelete}
        onOpenChange={(open) => !open && setAlertToDelete(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete alert</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this alert? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-row justify-end gap-3 mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setAlertToDelete(null)}
              className="min-h-[44px] rounded-[12px] px-4"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={handleConfirmDelete}
              className="min-h-[44px] rounded-[12px] px-4"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
