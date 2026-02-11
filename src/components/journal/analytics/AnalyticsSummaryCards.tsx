'use client';

import type { JournalAnalyticsSummary } from '@/types/journal-analytics';

interface AnalyticsSummaryCardsProps {
  summary: JournalAnalyticsSummary;
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
        {label}
      </p>
      <p
        className="text-lg font-mono tabular-nums font-semibold mt-0.5"
        style={color ? { color } : undefined}
        data-testid={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`}
      >
        {value}
      </p>
    </div>
  );
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

  const pnlColor = totalPnlPercent > 0 ? '#0ecb81' : totalPnlPercent < 0 ? '#f6465d' : undefined;
  const avgColor = avgPnlPercent > 0 ? '#0ecb81' : avgPnlPercent < 0 ? '#f6465d' : undefined;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" data-testid="analytics-summary">
      <StatCard label="Total Trades" value={String(totalTrades)} />
      <StatCard
        label="Win Rate"
        value={`${winRate.toFixed(1)}%`}
        color={winRate >= 50 ? '#0ecb81' : winRate > 0 ? '#f6465d' : undefined}
      />
      <StatCard label="Wins / Losses" value={`${wins} / ${losses}`} />
      <StatCard
        label="Total P&L"
        value={`${totalPnlPercent > 0 ? '+' : ''}${totalPnlPercent.toFixed(2)}%`}
        color={pnlColor}
      />
      <StatCard
        label="Avg P&L"
        value={`${avgPnlPercent > 0 ? '+' : ''}${avgPnlPercent.toFixed(2)}%`}
        color={avgColor}
      />
      <StatCard
        label="Best Trade"
        value={bestTrade !== null ? `+${bestTrade.toFixed(2)}%` : '-'}
        color={bestTrade !== null ? '#0ecb81' : undefined}
      />
      <StatCard
        label="Worst Trade"
        value={worstTrade !== null ? `${worstTrade.toFixed(2)}%` : '-'}
        color={worstTrade !== null ? '#f6465d' : undefined}
      />
      <StatCard
        label="Profit Factor"
        value={profitFactor !== null ? profitFactor.toFixed(2) : '-'}
        color={
          profitFactor !== null
            ? profitFactor >= 1
              ? '#0ecb81'
              : '#f6465d'
            : undefined
        }
      />
    </div>
  );
}
