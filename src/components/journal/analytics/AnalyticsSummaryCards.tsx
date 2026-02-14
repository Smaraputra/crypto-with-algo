'use client';

import type { JournalAnalyticsSummary } from '@/types/journal-analytics';

interface AnalyticsSummaryCardsProps {
  summary: JournalAnalyticsSummary;
}

function StatCard({
  label,
  value,
  colorClass,
}: {
  label: string;
  value: string;
  colorClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground uppercase tracking-wider">
        {label}
      </p>
      <p
        className={`text-lg font-mono tabular-nums font-semibold mt-0.5 ${colorClass ?? ''}`}
        data-testid={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`}
      >
        {value}
      </p>
    </div>
  );
}

function pnlClass(value: number): string | undefined {
  if (value > 0) return 'text-bullish';
  if (value < 0) return 'text-bearish';
  return undefined;
}

export function AnalyticsSummaryCards({ summary }: AnalyticsSummaryCardsProps) {
  const {
    totalTrades,
    wins,
    losses,
    winRate,
    avgPnlPercent,
    bestTrade,
    worstTrade,
    totalPnlPercent,
    profitFactor,
  } = summary;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" data-testid="analytics-summary">
      <StatCard label="Total Trades" value={String(totalTrades)} />
      <StatCard
        label="Win Rate"
        value={`${winRate.toFixed(1)}%`}
        colorClass={winRate >= 50 ? 'text-bullish' : winRate > 0 ? 'text-bearish' : undefined}
      />
      <StatCard label="Wins / Losses" value={`${wins} / ${losses}`} />
      <StatCard
        label="Total P&L"
        value={`${totalPnlPercent > 0 ? '+' : ''}${totalPnlPercent.toFixed(2)}%`}
        colorClass={pnlClass(totalPnlPercent)}
      />
      <StatCard
        label="Avg P&L"
        value={`${avgPnlPercent > 0 ? '+' : ''}${avgPnlPercent.toFixed(2)}%`}
        colorClass={pnlClass(avgPnlPercent)}
      />
      <StatCard
        label="Best Trade"
        value={bestTrade !== null ? `+${bestTrade.toFixed(2)}%` : '-'}
        colorClass={bestTrade !== null ? 'text-bullish' : undefined}
      />
      <StatCard
        label="Worst Trade"
        value={worstTrade !== null ? `${worstTrade.toFixed(2)}%` : '-'}
        colorClass={worstTrade !== null ? 'text-bearish' : undefined}
      />
      <StatCard
        label="Profit Factor"
        value={profitFactor !== null ? profitFactor.toFixed(2) : '-'}
        colorClass={
          profitFactor !== null
            ? profitFactor >= 1
              ? 'text-bullish'
              : 'text-bearish'
            : undefined
        }
      />
    </div>
  );
}
