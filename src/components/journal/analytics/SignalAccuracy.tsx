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
  strong_buy: '#0ecb81',
  buy: '#93c47d',
  neutral: '#848e9c',
  sell: '#f0945d',
  strong_sell: '#f6465d',
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
                  className="inline-block w-2 h-2 rounded-full mr-1.5"
                  style={{ backgroundColor: TIER_COLORS[row.tier] ?? '#848e9c' }}
                />
                {TIER_LABELS[row.tier] ?? row.tier}
              </td>
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
