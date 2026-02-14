'use client';

import type { MonthlyPnl } from '@/types/journal-analytics';

interface MonthlyPnLProps {
  data: MonthlyPnl[];
}

export function MonthlyPnL({ data }: MonthlyPnLProps) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4" data-testid="monthly-pnl-empty">
        No monthly data yet. Close some trades to see monthly P&L.
      </p>
    );
  }

  const maxAbsPnl = Math.max(...data.map((d) => Math.abs(d.pnlPercent)), 1);

  return (
    <div className="space-y-1" data-testid="monthly-pnl">
      {data.map((month) => {
        const isPositive = month.pnlPercent >= 0;
        const barWidth = (Math.abs(month.pnlPercent) / maxAbsPnl) * 100;

        return (
          <div key={month.month} className="flex items-center gap-2 text-xs">
            <span className="w-16 text-muted-foreground font-mono shrink-0">
              {month.month}
            </span>
            <div className="flex-1 flex items-center">
              {isPositive ? (
                <div className="w-1/2" />
              ) : (
                <div className="w-1/2 flex justify-end">
                  <div
                    className="h-4 rounded-sm bg-bearish"
                    style={{ width: `${barWidth}%` }}
                    data-testid={`bar-${month.month}`}
                  />
                </div>
              )}
              {isPositive ? (
                <div className="w-1/2">
                  <div
                    className="h-4 rounded-sm bg-bullish"
                    style={{ width: `${barWidth}%` }}
                    data-testid={`bar-${month.month}`}
                  />
                </div>
              ) : (
                <div className="w-1/2" />
              )}
            </div>
            <span
              className={`w-20 text-right font-mono tabular-nums shrink-0 ${isPositive ? 'text-bullish' : 'text-bearish'}`}
            >
              {isPositive ? '+' : ''}
              {month.pnlPercent.toFixed(2)}%
            </span>
            <span className="w-8 text-right text-muted-foreground shrink-0">
              {month.tradeCount}
            </span>
          </div>
        );
      })}
    </div>
  );
}
