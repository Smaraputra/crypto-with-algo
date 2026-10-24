'use client';

import React from 'react';
import { Panel } from '@/components/kit/Panel';
import { StateNotice } from '@/components/kit/StateNotice';
import type { KellySuggestion } from '@/types/journal-analytics';
import { cn } from '@/lib/utils';

export interface KellyPanelProps {
  suggestion: KellySuggestion;
  className?: string;
  level?: 2 | 3;
}

function formatFraction(val: number | null | undefined): { text: string; isMissing: boolean } {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return { text: 'n/a', isMissing: true };
  }
  const pct = Math.abs(val * 100) < 0.0001 ? 0 : val * 100;
  return { text: `${pct.toFixed(1)}%`, isMissing: false };
}

function formatPercentValue(val: number | null | undefined): { text: string; isMissing: boolean } {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return { text: 'n/a', isMissing: true };
  }
  const pct = Math.abs(val) < 0.0001 ? 0 : val;
  return { text: `${pct.toFixed(1)}%`, isMissing: false };
}

function formatCount(val: number | null | undefined): { text: string; isMissing: boolean } {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return { text: 'n/a', isMissing: true };
  }
  return { text: String(val), isMissing: false };
}

export const KellyPanel: React.FC<KellyPanelProps> = ({
  suggestion,
  className,
  level = 3,
}) => {
  const {
    reliable,
    fraction,
    halfFraction,
    winRate,
    avgWinPercent,
    avgLossPercent,
    sampleSize,
  } = suggestion;

  const isZero = fraction <= 0;
  const halfKelly = formatFraction(halfFraction);
  const fullKelly = formatFraction(fraction);
  const winRateFormatted = formatFraction(winRate);
  const avgWinFormatted = formatPercentValue(avgWinPercent);
  const avgLossFormatted = formatPercentValue(avgLossPercent);
  const sampleFormatted = formatCount(sampleSize);

  return (
    <Panel
      title="Position size (Kelly)"
      level={level}
      className={cn('p-4 sm:p-5', className)}
    >
      {!reliable ? (
        <StateNotice
          kind="empty"
          title="Not enough trades for a size suggestion yet."
          description={
            'It needs at least 20 closed trades that include both wins and losses. You have ' +
            sampleSize +
            '.'
          }
        />
      ) : (
        <div className="space-y-4">
          {isZero ? (
            <div className="flex items-baseline gap-2">
              <span className="text-[28px] font-semibold tracking-tight font-sans tabular-nums text-foreground">
                0%
              </span>
              <span className="text-[13px] text-muted-foreground">
                of equity per trade
              </span>
            </div>
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="text-[28px] font-semibold tracking-tight font-sans tabular-nums text-foreground">
                {halfKelly.text}
              </span>
              <span className="text-[13px] text-muted-foreground">
                of equity per trade (half Kelly)
              </span>
            </div>
          )}

          <dl className="grid grid-cols-2 sm:grid-cols-5 gap-4 pt-4 border-t border-line text-[14px]">
            <div>
              <dt className="text-muted-foreground text-[12px]">Full Kelly</dt>
              <dd
                className={cn(
                  'font-sans tabular-nums font-medium mt-0.5',
                  fullKelly.isMissing ? 'text-muted-foreground' : 'text-foreground'
                )}
              >
                {fullKelly.text}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-[12px]">Win rate</dt>
              <dd
                className={cn(
                  'font-sans tabular-nums font-medium mt-0.5',
                  winRateFormatted.isMissing ? 'text-muted-foreground' : 'text-foreground'
                )}
              >
                {winRateFormatted.text}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-[12px]">Average win</dt>
              <dd
                className={cn(
                  'font-sans tabular-nums font-medium mt-0.5',
                  avgWinFormatted.isMissing ? 'text-muted-foreground' : 'text-foreground'
                )}
              >
                {avgWinFormatted.text}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-[12px]">Average loss</dt>
              <dd
                className={cn(
                  'font-sans tabular-nums font-medium mt-0.5',
                  avgLossFormatted.isMissing ? 'text-muted-foreground' : 'text-foreground'
                )}
              >
                {avgLossFormatted.text}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-[12px]">Closed trades used</dt>
              <dd
                className={cn(
                  'font-sans tabular-nums font-medium mt-0.5',
                  sampleFormatted.isMissing ? 'text-muted-foreground' : 'text-foreground'
                )}
              >
                {sampleFormatted.text}
              </dd>
            </div>
          </dl>

          <p className="text-[13px] text-muted-foreground leading-relaxed">
            {isZero
              ? 'Your closed trades show no edge after their own win and loss sizes, so the suggestion is not to size up.'
              : 'From your own closed trades in this journal. Half Kelly is the usual practical size. It assumes your past win rate and win and loss sizes continue, which is not guaranteed.'}
          </p>
        </div>
      )}
    </Panel>
  );
};
