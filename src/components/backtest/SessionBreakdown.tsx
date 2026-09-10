'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SESSION_LABELS } from '@/lib/sessions';
import type { SessionBreakdownEntry } from '@/lib/backtest/types';
import { cn } from '@/lib/utils';

interface SessionBreakdownProps {
  breakdown: SessionBreakdownEntry[];
}

export function SessionBreakdown({ breakdown }: SessionBreakdownProps) {
  if (breakdown.length === 0) return null;

  return (
    <Card data-testid="session-breakdown">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Performance by Session (UTC)</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Session</th>
                <th className="pb-2 pr-4 text-right font-medium">Trades</th>
                <th className="pb-2 pr-4 text-right font-medium">Win Rate</th>
                <th className="pb-2 pr-4 text-right font-medium">Total P&L</th>
                <th className="pb-2 text-right font-medium">Avg P&L %</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map((entry) => (
                <tr key={entry.session} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-4">{SESSION_LABELS[entry.session]}</td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">{entry.trades}</td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">
                    {(entry.winRate * 100).toFixed(1)}%
                  </td>
                  <td
                    className={cn(
                      'py-2 pr-4 text-right font-mono tabular-nums',
                      entry.totalPnl >= 0 ? 'text-bullish' : 'text-bearish'
                    )}
                  >
                    {entry.totalPnl >= 0 ? '+' : ''}
                    {entry.totalPnl.toFixed(2)}
                  </td>
                  <td
                    className={cn(
                      'py-2 text-right font-mono tabular-nums',
                      entry.avgPnlPercent >= 0 ? 'text-bullish' : 'text-bearish'
                    )}
                  >
                    {entry.avgPnlPercent >= 0 ? '+' : ''}
                    {entry.avgPnlPercent.toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
