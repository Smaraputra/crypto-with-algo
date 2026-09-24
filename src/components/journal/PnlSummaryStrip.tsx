'use client';

import { useJournalAnalytics } from '@/hooks/useJournalAnalytics';
import { formatWinRate } from './analytics/format';

export function PnlSummaryStrip() {
  const { data, isLoading } = useJournalAnalytics();

  if (isLoading || !data) {
    return (
      <div
        className="flex gap-4 rounded-md border border-border bg-muted/30 px-3 py-2"
        data-testid="pnl-strip-loading"
      >
        <span className="text-xs text-muted-foreground">Loading stats...</span>
      </div>
    );
  }

  const { summary } = data;
  // closedTrades used to gate the win-rate dash here. The route now returns
  // null for "no closed trades", so formatWinRate carries that meaning and the
  // local recomputation is gone -- it was the second definition of the same idea
  // and the analytics cards, lacking it, printed 0.0% for the same data.

  return (
    <div
      className="flex flex-wrap gap-x-6 gap-y-1 rounded-md border border-border bg-muted/30 px-3 py-2"
      data-testid="pnl-summary-strip"
    >
      <Stat
        label="Total P&L"
        value={
          <span
            className={`font-mono tabular-nums ${
              summary.totalPnlPercent > 0
                ? 'text-bullish'
                : summary.totalPnlPercent < 0
                  ? 'text-bearish'
                  : 'text-muted-foreground'
            }`}
          >
            {summary.totalPnlPercent > 0 ? '+' : ''}
            {summary.totalPnlPercent.toFixed(2)}%
          </span>
        }
      />
      <Stat
        label="Win Rate"
        value={
          <span className="font-mono tabular-nums">
            {formatWinRate(summary.winRate)}
          </span>
        }
      />
      <Stat
        label="Profit Factor"
        value={
          <span className="font-mono tabular-nums">
            {summary.profitFactor != null ? summary.profitFactor.toFixed(2) : '-'}
          </span>
        }
      />
      <Stat
        label="Trades"
        value={
          <span className="font-mono tabular-nums">{summary.totalTrades}</span>
        }
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-xs text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <span className="text-xs font-medium">{value}</span>
    </div>
  );
}
