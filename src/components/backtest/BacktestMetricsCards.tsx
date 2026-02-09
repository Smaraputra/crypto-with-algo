'use client';

import { Card, CardContent } from '@/components/ui/card';
import type { BacktestMetrics } from '@/lib/backtest/types';

interface BacktestMetricsCardsProps {
  metrics: BacktestMetrics;
}

function formatNum(value: number, decimals = 2): string {
  return value.toFixed(decimals);
}

function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatUSD(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(value);
}

function pnlColor(value: number): string {
  if (value > 0) return 'text-green-500';
  if (value < 0) return 'text-red-500';
  return 'text-muted-foreground';
}

interface MetricItem {
  label: string;
  value: string;
  color?: string;
}

export function BacktestMetricsCards({ metrics }: BacktestMetricsCardsProps) {
  const items: MetricItem[] = [
    {
      label: 'Total PnL',
      value: formatUSD(metrics.totalPnl),
      color: pnlColor(metrics.totalPnl),
    },
    {
      label: 'Total Return',
      value: formatPct(metrics.totalPnlPercent),
      color: pnlColor(metrics.totalPnlPercent),
    },
    { label: 'Total Trades', value: String(metrics.totalTrades) },
    {
      label: 'Win Rate',
      value: `${(metrics.winRate * 100).toFixed(1)}%`,
    },
    {
      label: 'Profit Factor',
      value: metrics.profitFactor === Infinity ? 'inf' : formatNum(metrics.profitFactor),
    },
    {
      label: 'Max Drawdown',
      value: formatPct(-metrics.maxDrawdownPercent),
      color: 'text-red-500',
    },
    { label: 'Sharpe Ratio', value: formatNum(metrics.sharpeRatio) },
    { label: 'Sortino Ratio', value: formatNum(metrics.sortinoRatio) },
    {
      label: 'Avg Win',
      value: formatUSD(metrics.avgWin),
      color: 'text-green-500',
    },
    {
      label: 'Avg Loss',
      value: formatUSD(metrics.avgLoss),
      color: 'text-red-500',
    },
    { label: 'Total Fees', value: formatUSD(metrics.totalFees) },
    {
      label: 'Winning / Losing',
      value: `${metrics.winningTrades} / ${metrics.losingTrades}`,
    },
  ];

  return (
    <div
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
      data-testid="backtest-metrics"
    >
      {items.map((item) => (
        <Card key={item.label} className="p-0">
          <CardContent className="px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {item.label}
            </p>
            <p
              className={`font-mono text-sm tabular-nums ${
                item.color ?? 'text-foreground'
              }`}
            >
              {item.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
