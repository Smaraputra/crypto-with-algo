'use client';

import { Card, CardContent } from '@/components/ui/card';
import { usePortfolioHistory, useCostBasis } from '@/hooks/useAnalytics';

interface AnalyticsSummaryCardsProps {
  portfolioId: string | null;
  range: number;
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

export function AnalyticsSummaryCards({ portfolioId, range }: AnalyticsSummaryCardsProps) {
  const { data: historyData, isLoading: historyLoading } = usePortfolioHistory(portfolioId, range);
  const { data: costData, isLoading: costLoading } = useCostBasis(portfolioId);

  const isLoading = historyLoading || costLoading;

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="summary-cards-skeleton">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-sm animate-shimmer" />
        ))}
      </div>
    );
  }

  const history = historyData?.history ?? [];
  const latestSnapshot = history.length > 0 ? history[history.length - 1] : null;
  const firstSnapshot = history.length > 0 ? history[0] : null;

  const totalValue = latestSnapshot?.totalValue ?? 0;
  const unrealizedPnl = latestSnapshot?.unrealizedPnl ?? 0;
  const unrealizedPnlPercent = latestSnapshot?.unrealizedPnlPercent ?? 0;
  const realizedGain = costData?.costBasis.totalRealizedGain ?? 0;

  const periodReturn =
    firstSnapshot && latestSnapshot && firstSnapshot.totalValue > 0
      ? ((latestSnapshot.totalValue - firstSnapshot.totalValue) / firstSnapshot.totalValue) * 100
      : 0;

  const cards = [
    {
      label: 'Total Value',
      value: formatCurrency(totalValue),
      sub: latestSnapshot ? `As of ${new Date(latestSnapshot.date).toLocaleDateString()}` : 'No data',
      color: '',
    },
    {
      label: 'Unrealized P&L',
      value: formatCurrency(unrealizedPnl),
      sub: formatPercent(unrealizedPnlPercent),
      color: unrealizedPnl >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]',
    },
    {
      label: 'Realized P&L',
      value: formatCurrency(realizedGain),
      sub: 'FIFO cost basis',
      color: realizedGain >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]',
    },
    {
      label: 'Period Return',
      value: formatPercent(periodReturn),
      sub: `${range}-day period`,
      color: periodReturn >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="analytics-summary-cards">
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
