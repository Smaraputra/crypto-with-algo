'use client';

import { Card, CardContent } from '@/components/ui/card';
import { useRiskMetrics } from '@/hooks/useAnalytics';

interface RiskMetricsCardsProps {
  portfolioId: string | null;
  range: number;
}

function formatPercent(value: number | null): string {
  if (value === null) return '--';
  return `${(value * 100).toFixed(2)}%`;
}

function formatRatio(value: number | null): string {
  if (value === null) return '--';
  return value.toFixed(2);
}

export function RiskMetricsCards({ portfolioId, range }: RiskMetricsCardsProps) {
  const { data, isLoading } = useRiskMetrics(portfolioId, range);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="risk-metrics-skeleton">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 rounded-sm animate-shimmer" />
        ))}
      </div>
    );
  }

  if (!data || data.insufficientData) {
    const daysNeeded = data ? data.minRequired - data.dataPoints : 30;
    return (
      <Card data-testid="risk-metrics-insufficient">
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">
            Insufficient data for risk metrics.
            {daysNeeded > 0 && ` Need ${daysNeeded} more day${daysNeeded !== 1 ? 's' : ''} of snapshots.`}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {data ? `${data.dataPoints} of ${data.minRequired} data points collected.` : ''}
          </p>
        </CardContent>
      </Card>
    );
  }

  const metrics = data.metrics!;

  const cards = [
    {
      label: 'Sharpe Ratio',
      value: formatRatio(metrics.sharpeRatio),
      sub: 'Risk-adjusted return',
      color: metrics.sharpeRatio !== null && metrics.sharpeRatio > 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]',
    },
    {
      label: 'Sortino Ratio',
      value: formatRatio(metrics.sortinoRatio),
      sub: 'Downside risk-adjusted',
      color: metrics.sortinoRatio !== null && metrics.sortinoRatio > 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]',
    },
    {
      label: 'Max Drawdown',
      value: formatPercent(metrics.maxDrawdown),
      sub: metrics.maxDrawdownDate ? new Date(metrics.maxDrawdownDate).toLocaleDateString() : '',
      color: 'text-[#f6465d]',
    },
    {
      label: 'Volatility',
      value: formatPercent(metrics.annualizedVolatility),
      sub: 'Annualized',
      color: 'text-muted-foreground',
    },
    {
      label: 'Best Day',
      value: metrics.bestDay ? formatPercent(metrics.bestDay.return) : '--',
      sub: metrics.bestDay ? new Date(metrics.bestDay.date).toLocaleDateString() : '',
      color: 'text-[#0ecb81]',
    },
    {
      label: 'Worst Day',
      value: metrics.worstDay ? formatPercent(metrics.worstDay.return) : '--',
      sub: metrics.worstDay ? new Date(metrics.worstDay.date).toLocaleDateString() : '',
      color: 'text-[#f6465d]',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="risk-metrics-cards">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent className="py-3">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p className={`font-mono tabular-nums text-lg font-semibold ${card.color}`}>
              {card.value}
            </p>
            <p className="text-xs text-muted-foreground">{card.sub}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
