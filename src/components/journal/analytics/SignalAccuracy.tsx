'use client';

import type { SignalTierAccuracy } from '@/types/journal-analytics';

interface SignalAccuracyProps {
  data: SignalTierAccuracy[];
}

const TIER_LABELS: Record<string, string> = {
  strong_buy: 'Strong Buy',
  buy: 'Buy',
  neutral: 'Neutral',
  sell: 'Sell',
  strong_sell: 'Strong Sell',
};

const TIER_COLORS: Record<string, string> = {
  strong_buy: 'bg-bullish',
  buy: 'bg-bullish/60',
  neutral: 'bg-muted-foreground',
  sell: 'bg-bearish/60',
  strong_sell: 'bg-bearish',
};

export function SignalAccuracy({ data }: SignalAccuracyProps) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4" data-testid="signal-accuracy-empty">
        No signal accuracy data yet. Close trades to measure signal quality.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto" data-testid="signal-accuracy">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-4">Signal Tier</th>
            <th className="pb-2 pr-4 text-right">Trades</th>
            <th className="pb-2 pr-4 text-right">Win Rate</th>
            <th className="pb-2 text-right">Avg P&L</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.tier} className="border-b border-border/50">
              <td className="py-1.5 pr-4 text-xs font-medium">
                <span
                  className={`inline-block w-2 h-2 rounded-full mr-1.5 ${TIER_COLORS[row.tier] ?? 'bg-muted-foreground'}`}
                />
                {TIER_LABELS[row.tier] ?? row.tier}
              </td>
              <td className="py-1.5 pr-4 text-xs text-right font-mono tabular-nums">
                {row.count}
              </td>
              <td
                className={`py-1.5 pr-4 text-xs text-right font-mono tabular-nums ${row.winRate >= 50 ? 'text-bullish' : 'text-bearish'}`}
              >
                {row.winRate.toFixed(1)}%
              </td>
              <td
                className={`py-1.5 text-xs text-right font-mono tabular-nums ${
                  row.avgPnlPercent > 0 ? 'text-bullish' : row.avgPnlPercent < 0 ? 'text-bearish' : ''
                }`}
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
