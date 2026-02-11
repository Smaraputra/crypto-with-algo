'use client';

import type { SetupPerformance } from '@/types/journal-analytics';

interface PerformanceBySetupProps {
  data: SetupPerformance[];
}

export function PerformanceBySetup({ data }: PerformanceBySetupProps) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4" data-testid="setup-empty">
        No setup data yet. Add setup types to your journal entries.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto" data-testid="performance-by-setup">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-4">Setup Type</th>
            <th className="pb-2 pr-4 text-right">Trades</th>
            <th className="pb-2 pr-4 text-right">Win Rate</th>
            <th className="pb-2 text-right">Avg P&L</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.setupType} className="border-b border-border/50">
              <td className="py-1.5 pr-4 text-xs font-medium">{row.setupType}</td>
              <td className="py-1.5 pr-4 text-xs text-right font-mono tabular-nums">
                {row.count}
              </td>
              <td
                className="py-1.5 pr-4 text-xs text-right font-mono tabular-nums"
                style={{ color: row.winRate >= 50 ? '#0ecb81' : '#f6465d' }}
              >
                {row.winRate.toFixed(1)}%
              </td>
              <td
                className="py-1.5 text-xs text-right font-mono tabular-nums"
                style={{
                  color: row.avgPnlPercent > 0 ? '#0ecb81' : row.avgPnlPercent < 0 ? '#f6465d' : undefined,
                }}
              >
                {row.avgPnlPercent > 0 ? '+' : ''}
                {row.avgPnlPercent.toFixed(2)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
