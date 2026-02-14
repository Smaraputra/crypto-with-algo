'use client';

import { AlertTriangle, TrendingDown, TrendingUp } from 'lucide-react';
import type { JournalAnalyticsSummary, MonthlyPnl } from '@/types/journal-analytics';

interface TradingPatternsProps {
  summary: JournalAnalyticsSummary;
  byMonth: MonthlyPnl[];
}

interface Pattern {
  type: 'warning' | 'positive' | 'info';
  label: string;
  description: string;
}

function detectPatterns(summary: JournalAnalyticsSummary, byMonth: MonthlyPnl[]): Pattern[] {
  const patterns: Pattern[] = [];

  // Win streak / loss streak detection from summary
  if (summary.wins >= 5 && summary.winRate >= 70) {
    patterns.push({
      type: 'positive',
      label: 'Strong Win Rate',
      description: `${summary.winRate.toFixed(0)}% win rate across ${summary.wins + summary.losses} closed trades.`,
    });
  }

  if (summary.losses >= 5 && summary.winRate < 40) {
    patterns.push({
      type: 'warning',
      label: 'Low Win Rate',
      description: `Win rate is ${summary.winRate.toFixed(0)}%. Review your entry criteria and setup selection.`,
    });
  }

  // Profit factor analysis
  if (summary.profitFactor !== null) {
    if (summary.profitFactor >= 2) {
      patterns.push({
        type: 'positive',
        label: 'High Profit Factor',
        description: `Profit factor of ${summary.profitFactor.toFixed(2)} indicates strong risk-reward management.`,
      });
    } else if (summary.profitFactor < 1 && summary.wins + summary.losses >= 5) {
      patterns.push({
        type: 'warning',
        label: 'Negative Expectancy',
        description: `Profit factor of ${summary.profitFactor.toFixed(2)} means losses outweigh wins. Consider tighter stop losses.`,
      });
    }
  }

  // Monthly consistency
  if (byMonth.length >= 3) {
    const positiveMonths = byMonth.filter((m) => m.pnlPercent > 0).length;
    const monthlyRate = (positiveMonths / byMonth.length) * 100;

    if (monthlyRate >= 70) {
      patterns.push({
        type: 'positive',
        label: 'Consistent Monthly Profits',
        description: `${positiveMonths} of ${byMonth.length} months profitable (${monthlyRate.toFixed(0)}%).`,
      });
    }

    const consecutiveLosses = longestStreak(byMonth.map((m) => m.pnlPercent < 0));
    if (consecutiveLosses >= 3) {
      patterns.push({
        type: 'warning',
        label: 'Losing Streak',
        description: `${consecutiveLosses} consecutive losing months detected. Consider reducing position size.`,
      });
    }
  }

  // Overtrading detection
  if (byMonth.length > 0) {
    const avgTradesPerMonth = byMonth.reduce((s, m) => s + m.tradeCount, 0) / byMonth.length;
    const highTradeMonths = byMonth.filter((m) => m.tradeCount > avgTradesPerMonth * 2);
    if (highTradeMonths.length > 0 && avgTradesPerMonth >= 3) {
      const worstHighTradeMonth = highTradeMonths.sort((a, b) => a.pnlPercent - b.pnlPercent)[0];
      if (worstHighTradeMonth && worstHighTradeMonth.pnlPercent < 0) {
        patterns.push({
          type: 'warning',
          label: 'Possible Overtrading',
          description: `${worstHighTradeMonth.month} had ${worstHighTradeMonth.tradeCount} trades (2x avg) with negative P&L.`,
        });
      }
    }
  }

  if (patterns.length === 0) {
    patterns.push({
      type: 'info',
      label: 'Insufficient Data',
      description: 'Keep logging and closing trades to unlock pattern detection insights.',
    });
  }

  return patterns;
}

function longestStreak(booleans: boolean[]): number {
  let max = 0;
  let current = 0;
  for (const v of booleans) {
    if (v) {
      current++;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function PatternIcon({ type }: { type: Pattern['type'] }) {
  switch (type) {
    case 'warning':
      return <AlertTriangle className="size-4 text-yellow-500 shrink-0" />;
    case 'positive':
      return <TrendingUp className="size-4 text-green-500 shrink-0" />;
    case 'info':
      return <TrendingDown className="size-4 text-muted-foreground shrink-0" />;
  }
}

export function TradingPatterns({ summary, byMonth }: TradingPatternsProps) {
  const patterns = detectPatterns(summary, byMonth);

  return (
    <div className="space-y-2" data-testid="trading-patterns">
      {patterns.map((pattern, i) => (
        <div
          key={i}
          className="flex items-start gap-2 rounded-md border border-border p-2"
        >
          <PatternIcon type={pattern.type} />
          <div>
            <p className="text-xs font-medium">{pattern.label}</p>
            <p className="text-xs text-muted-foreground">{pattern.description}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
