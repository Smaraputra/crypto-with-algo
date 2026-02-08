'use client';

import { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useTickers } from '@/hooks/usePrices';
import type { Ticker24h } from '@/types/market';

interface PortfolioSummaryProps {
  portfolioId: string | null;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function PortfolioSummary({ portfolioId }: PortfolioSummaryProps) {
  const { data, isLoading } = usePortfolio(portfolioId);
  const holdings = useMemo(
    () => data?.portfolio?.holdings ?? [],
    [data]
  );
  const heldSymbols = useMemo(
    () => holdings.map((h) => h.symbol),
    [holdings]
  );
  const { tickers: liveTickers, isConnected } = useBinanceTicker(heldSymbols);
  const { data: restTickers } = useTickers();

  const summary = useMemo(() => {
    if (holdings.length === 0) return null;

    let totalValue = 0;
    let totalCost = 0;
    let totalChange24h = 0;
    let totalValue24hAgo = 0;

    for (const holding of holdings) {
      const live = liveTickers[holding.symbol];
      const rest = restTickers?.find((t: Ticker24h) => t.symbol === holding.symbol);
      const ticker = live ?? rest ?? null;

      if (!ticker) continue;

      const currentPrice = parseFloat(ticker.lastPrice);
      const openPrice = parseFloat(ticker.openPrice);
      const value = currentPrice * holding.quantity;
      const cost = holding.avgBuyPrice * holding.quantity;
      const value24hAgo = openPrice * holding.quantity;

      totalValue += value;
      totalCost += cost;
      totalChange24h += value - value24hAgo;
      totalValue24hAgo += value24hAgo;
    }

    const totalPnL = totalValue - totalCost;
    const totalPnLPercent = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;
    const change24hPercent = totalValue24hAgo > 0
      ? (totalChange24h / totalValue24hAgo) * 100
      : 0;

    return {
      totalValue,
      totalPnL,
      totalPnLPercent,
      totalChange24h,
      change24hPercent,
      holdingsCount: holdings.length,
    };
  }, [holdings, liveTickers, restTickers]);

  if (!portfolioId) {
    return null;
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="summary-skeleton">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-sm animate-shimmer" />
        ))}
      </div>
    );
  }

  if (!summary) {
    return (
      <Card data-testid="summary-empty">
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">
            No holdings yet. Add your first holding to see portfolio summary.
          </p>
        </CardContent>
      </Card>
    );
  }

  const cards = [
    {
      label: 'Total Value',
      value: formatCurrency(summary.totalValue),
      sub: `${summary.holdingsCount} holding${summary.holdingsCount !== 1 ? 's' : ''}`,
      color: '',
    },
    {
      label: 'Total P&L',
      value: formatCurrency(summary.totalPnL),
      sub: formatPercent(summary.totalPnLPercent),
      color: summary.totalPnL >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]',
    },
    {
      label: '24h Change',
      value: formatCurrency(summary.totalChange24h),
      sub: formatPercent(summary.change24hPercent),
      color: summary.totalChange24h >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]',
    },
    {
      label: 'Connection',
      value: isConnected ? 'Live' : 'REST',
      sub: isConnected ? 'WebSocket active' : 'Delayed prices',
      color: isConnected ? 'text-[#0ecb81]' : 'text-muted-foreground',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="portfolio-summary">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent className="py-3">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p className={`font-mono tabular-nums text-lg font-semibold ${card.color}`}>
              {card.value}
            </p>
            <p className={`text-xs ${card.color || 'text-muted-foreground'}`}>
              {card.sub}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
