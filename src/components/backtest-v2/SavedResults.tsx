'use client';

import React, { useState } from 'react';
import { useBacktestResults, useDeleteBacktestResult } from '@/hooks/useBacktestResults';
import type { BacktestResultSummary, SavedBacktestResult } from '@/types/backtest';
import { formatDataStatusDate } from './StrategyConfig';
import { StateNotice } from '@/components/kit/StateNotice';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface SavedResultsProps {
  onSelectResult?: (result: SavedBacktestResult) => void;
  className?: string;
}

function formatCurrency(val: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

function formatSignedCurrency(val: number, pct?: number): {
  text: string;
  className: string;
} {
  const isPositive = val > 0.0001;
  const isNegative = val < -0.0001;
  const sign = isPositive ? '+' : isNegative ? '-' : '';
  const formattedVal = `${sign}${formatCurrency(Math.abs(val))}`;
  const color = isPositive ? 'text-up' : isNegative ? 'text-down' : 'text-foreground';

  if (pct !== undefined) {
    const absPct = Math.abs(pct);
    return {
      text: `${formattedVal} (${sign}${absPct.toFixed(2)}%)`,
      className: color,
    };
  }
  return {
    text: formattedVal,
    className: color,
  };
}

export const SavedResults: React.FC<SavedResultsProps> = ({
  onSelectResult,
  className,
}) => {
  const { data, isLoading, isError, refetch } = useBacktestResults();
  const deleteMutation = useDeleteBacktestResult();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [failedLoadIds, setFailedLoadIds] = useState<Record<string, boolean>>({});

  const results = data?.results ?? [];

  const handleOpenResult = async (item: BacktestResultSummary) => {
    // Toggle expand
    if (expandedId === item._id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(item._id);

    // If caller wants full detail loaded into active results
    if (onSelectResult) {
      setLoadingDetailId(item._id);
      setFailedLoadIds((prev) => ({ ...prev, [item._id]: false }));
      try {
        const res = await fetch(`/api/backtests/${item._id}`);
        if (!res.ok) {
          throw new Error('Failed to load saved backtest');
        }
        const detail = await res.json();
        if (!detail?.result) {
          throw new Error('Invalid backtest result data');
        }
        onSelectResult(detail.result);
      } catch {
        setFailedLoadIds((prev) => ({ ...prev, [item._id]: true }));
      } finally {
        setLoadingDetailId(null);
      }
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteMutation.mutateAsync(id);
      if (expandedId === id) setExpandedId(null);
      setConfirmDeleteId(null);
    } catch {
      setConfirmDeleteId(null);
    }
  };

  return (
    <div className={cn('bg-card rounded-panel p-5 sm:p-6 border border-line space-y-4', className)}>
      <h3 className="text-[16px] font-semibold text-foreground">
        Saved backtests
      </h3>

      {isLoading && (
        <StateNotice kind="loading" title="Loading saved backtests..." />
      )}

      {isError && (
        <StateNotice
          kind="error"
          title="Failed to load saved backtests"
          action={
            <Button
              variant="outline"
              onClick={() => refetch()}
              className="min-h-[44px] rounded-[12px]"
            >
              Try again
            </Button>
          }
        />
      )}

      {!isLoading && !isError && results.length === 0 && (
        <StateNotice
          kind="empty"
          title="No saved backtests"
          description="Saved runs will appear here."
        />
      )}

      {!isLoading && !isError && results.length > 0 && (
        <div className="space-y-3">
          {results.map((item) => {
            const isExpanded = expandedId === item._id;
            const isConfirming = confirmDeleteId === item._id;
            const isZeroTrades = item.metrics.totalTrades === 0;
            const pnl = formatSignedCurrency(
              item.metrics.totalPnl,
              item.metrics.totalPnlPercent
            );
            const createdDate = formatDataStatusDate(Date.parse(item.createdAt));

            return (
              <div
                key={item._id}
                className="p-4 rounded-[14px] border border-line bg-muted/20 hover:bg-muted/30 transition-colors space-y-3"
              >
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold text-[15px] text-foreground">
                      {item.symbol} {item.interval}
                    </span>
                    <span className="text-[13px] text-muted-foreground ml-2 font-sans tabular-nums">
                      {createdDate}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 self-stretch sm:self-auto justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpenResult(item)}
                      disabled={loadingDetailId === item._id}
                      className="min-h-[44px] rounded-[10px] text-[13px] font-semibold px-3"
                    >
                      {loadingDetailId === item._id
                        ? 'Opening...'
                        : isExpanded
                        ? 'Hide metrics'
                        : 'View metrics'}
                    </Button>

                    {!isConfirming ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirmDeleteId(item._id)}
                        className="min-h-[44px] rounded-[10px] text-[13px] font-semibold text-down border-edge hover:border-down px-3"
                      >
                        Delete
                      </Button>
                    ) : (
                      <div className="flex items-center gap-1.5 p-1 border border-line rounded-[10px] bg-card">
                        <span className="text-[12px] text-muted-foreground pl-1">Confirm?</span>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDelete(item._id)}
                          disabled={deleteMutation.isPending}
                          className="min-h-[44px] rounded-[8px] text-[12px] font-semibold px-2.5"
                        >
                          Delete
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setConfirmDeleteId(null)}
                          className="min-h-[44px] rounded-[8px] text-[12px] px-2.5"
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Key metrics row */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[13px] font-sans tabular-nums">
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Total P&L</span>
                    {isZeroTrades ? (
                      <span className="font-semibold text-muted-foreground">n/a</span>
                    ) : (
                      <span className={cn('font-semibold', pnl.className)}>{pnl.text}</span>
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Win rate</span>
                    <span className={cn('font-semibold', isZeroTrades ? 'text-muted-foreground' : 'text-foreground')}>
                      {isZeroTrades ? 'n/a' : `${(item.metrics.winRate * 100).toFixed(1)}%`}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Sharpe</span>
                    <span className={cn('font-semibold', isZeroTrades ? 'text-muted-foreground' : 'text-foreground')}>
                      {isZeroTrades ? 'n/a' : item.metrics.sharpeRatio.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Trades</span>
                    <span className="font-semibold text-foreground">
                      {item.metrics.totalTrades}
                    </span>
                  </div>
                </div>

                {isZeroTrades && (
                  <p className="text-[12px] text-muted-foreground">
                    No trades were taken in this run.
                  </p>
                )}

                {/* Failed to open detail error line */}
                {failedLoadIds[item._id] && (
                  <div
                    role="alert"
                    className="flex items-center justify-between gap-2 p-2.5 rounded-[10px] bg-muted/40 border border-edge text-[13px] text-down"
                  >
                    <span>This saved run did not load.</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpenResult(item)}
                      className="min-h-[36px] rounded-[8px] text-[12px] font-semibold px-2.5"
                    >
                      Try again
                    </Button>
                  </div>
                )}

                {/* Expanded Detailed Metrics */}
                {isExpanded && (
                  <div
                    data-testid={`expanded-metrics-${item._id}`}
                    className="pt-3 border-t border-line grid grid-cols-2 sm:grid-cols-4 gap-3 text-[13px] font-sans tabular-nums bg-card/60 p-3 rounded-[10px]"
                  >
                    <div>
                      <span className="text-muted-foreground block text-[11px]">Profit factor</span>
                      <span className={cn('font-semibold', isZeroTrades ? 'text-muted-foreground' : 'text-foreground')}>
                        {isZeroTrades
                          ? 'n/a'
                          : item.metrics.profitFactor === Infinity
                          ? 'Infinity'
                          : item.metrics.profitFactor.toFixed(2)}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-[11px]">Max drawdown</span>
                      <span className={cn('font-semibold', isZeroTrades ? 'text-muted-foreground' : 'text-foreground')}>
                        {isZeroTrades ? 'n/a' : `${item.metrics.maxDrawdownPercent.toFixed(1)}%`}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-[11px]">Expectancy</span>
                      <span
                        className={cn(
                          'font-semibold',
                          isZeroTrades
                            ? 'text-muted-foreground'
                            : item.metrics.expectancyPercent >= 0
                            ? 'text-up'
                            : 'text-down'
                        )}
                      >
                        {isZeroTrades
                          ? 'n/a'
                          : `${item.metrics.expectancyPercent >= 0 ? '+' : ''}${item.metrics.expectancyPercent.toFixed(2)}%`}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-[11px]">Total fees</span>
                      <span className={cn('font-semibold', isZeroTrades ? 'text-muted-foreground' : 'text-foreground')}>
                        {isZeroTrades ? 'n/a' : formatCurrency(item.metrics.totalFees)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
