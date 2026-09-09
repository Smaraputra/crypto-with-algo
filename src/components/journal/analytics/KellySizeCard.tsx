'use client';

import { cn } from '@/lib/utils';
import type { KellySuggestion } from '@/types/journal-analytics';

interface KellySizeCardProps {
  suggestion: KellySuggestion;
}

export function KellySizeCard({ suggestion }: KellySizeCardProps) {
  const { reliable, halfFraction, winRate, avgWinPercent, avgLossPercent, sampleSize } = suggestion;

  return (
    <div data-testid="kelly-size-card" className={cn(!reliable && 'opacity-60')}>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-mono tabular-nums" data-testid="kelly-suggested-size">
          {reliable ? `${(halfFraction * 100).toFixed(1)}%` : '--'}
        </span>
        <span className="text-xs text-muted-foreground">of equity per trade (half Kelly)</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {reliable ? (
          <>
            From your record: {(winRate * 100).toFixed(0)}% win rate, avg win{' '}
            <span className="font-mono tabular-nums">+{avgWinPercent.toFixed(2)}%</span>, avg loss{' '}
            <span className="font-mono tabular-nums">-{avgLossPercent.toFixed(2)}%</span> over{' '}
            {sampleSize} closed trades. Advisory only; half Kelly tempers estimation error.
          </>
        ) : (
          <>
            Needs at least 20 closed trades with both wins and losses ({sampleSize} so far). Keep
            journaling outcomes to unlock a size suggestion from your own record.
          </>
        )}
      </p>
    </div>
  );
}
