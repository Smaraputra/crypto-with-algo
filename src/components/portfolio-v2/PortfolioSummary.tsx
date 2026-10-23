'use client';

import React, { useMemo } from 'react';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useTickers } from '@/hooks/usePrices';
import { cn } from '@/lib/utils';
import type { Holding } from '@/types/portfolio';

export interface PortfolioSummaryProps {
  holdings: Holding[];
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

export const PortfolioSummary: React.FC<PortfolioSummaryProps> = ({
  holdings,
  className,
}) => {
  const symbols = useMemo(() => holdings.map((h) => h.symbol), [holdings]);
  const { tickers: binanceTickers } = useBinanceTicker(symbols);
  const { data: restTickers } = useTickers();

  const pricesMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const h of holdings) {
      const live = binanceTickers[h.symbol]?.lastPrice;
      if (live) {
        const parsed = parseFloat(live);
        if (Number.isFinite(parsed)) {
          map[h.symbol] = parsed;
          continue;
        }
      }
      const rest = restTickers?.find((t) => t.symbol === h.symbol)?.lastPrice;
      if (rest) {
        const parsed = parseFloat(rest);
        if (Number.isFinite(parsed)) {
          map[h.symbol] = parsed;
        }
      }
    }
    return map;
  }, [holdings, binanceTickers, restTickers]);

  const hasHoldings = holdings.length > 0;
  const hasPrices = hasHoldings && Object.keys(pricesMap).length > 0;
  const showPlaceholder = hasHoldings && !hasPrices;

  const totalCost = useMemo(() => {
    return holdings.reduce((sum, h) => sum + h.quantity * h.avgBuyPrice, 0);
  }, [holdings]);

  const totalValue = useMemo(() => {
    if (!hasHoldings) return 0;
    return holdings.reduce((sum, h) => {
      const price = pricesMap[h.symbol] ?? h.avgBuyPrice;
      return sum + h.quantity * price;
    }, 0);
  }, [holdings, hasHoldings, pricesMap]);

  const unrealizedPnl = totalValue - totalCost;
  const unrealizedPnlPercent = totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0;

  let pnlDirection: 'up' | 'down' | 'flat' = 'flat';
  if (unrealizedPnl > 0.0001) {
    pnlDirection = 'up';
  } else if (unrealizedPnl < -0.0001) {
    pnlDirection = 'down';
  }

  const formattedValue = formatCurrency(totalValue);
  const formattedCost = formatCurrency(totalCost);

  let formattedPnl: string;
  let formattedPercent: string;
  if (pnlDirection === 'up') {
    formattedPnl = `+${formatCurrency(unrealizedPnl)}`;
    formattedPercent = `+${unrealizedPnlPercent.toFixed(2)}%`;
  } else if (pnlDirection === 'down') {
    formattedPnl = `-${formatCurrency(Math.abs(unrealizedPnl))}`;
    formattedPercent = `-${Math.abs(unrealizedPnlPercent).toFixed(2)}%`;
  } else {
    formattedPnl = `+${formatCurrency(0)}`;
    formattedPercent = '+0.00%';
  }

  return (
    <div
      data-testid="portfolio-summary"
      className={cn(
        'bg-card rounded-panel p-6 sm:p-8 flex flex-col gap-4 border border-line',
        className
      )}
    >
      <div className="space-y-2">
        <span className="text-[14px] font-medium text-muted-foreground block">
          Total value
        </span>
        <div>
          {showPlaceholder ? (
            <span
              data-testid="portfolio-value-placeholder"
              className="inline-block h-10 sm:h-14 w-48 rounded-[8px] bg-muted animate-pulse"
              aria-label="Loading total value"
            />
          ) : (
            <span
              data-testid="total-value"
              className="font-sans font-semibold tracking-[-0.02em] tabular-nums text-foreground leading-none text-[40px] sm:text-[56px] block"
            >
              {formattedValue}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-6 pt-3 border-t border-line text-[14px]">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Total cost:</span>
          {showPlaceholder ? (
            <span
              data-testid="portfolio-cost-placeholder"
              className="inline-block h-5 w-24 rounded-[6px] bg-muted animate-pulse"
              aria-label="Loading total cost"
            />
          ) : (
            <span
              data-testid="total-cost"
              className="font-sans font-semibold tabular-nums text-foreground"
            >
              {formattedCost}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Unrealised P&L:</span>
          {showPlaceholder ? (
            <span
              data-testid="portfolio-pnl-placeholder"
              className="inline-block h-5 w-32 rounded-[6px] bg-muted animate-pulse"
              aria-label="Loading unrealised P&L"
            />
          ) : (
            <span
              data-testid="unrealized-pnl"
              className={cn(
                'font-sans font-semibold tabular-nums',
                pnlDirection === 'up' && 'text-up',
                pnlDirection === 'down' && 'text-down',
                pnlDirection === 'flat' && 'text-muted-foreground'
              )}
            >
              {formattedPnl} ({formattedPercent})
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
