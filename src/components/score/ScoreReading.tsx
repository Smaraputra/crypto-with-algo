'use client';

import React from 'react';
import { EvidenceChip } from '@/components/kit/EvidenceChip';
import { StateNotice } from '@/components/kit/StateNotice';
import { useLatestSignalForStyle } from '@/hooks/useSignals';
import type { TradingStyle } from '@/lib/models/signal-template';
import type { GlobalSignalRecord } from '@/hooks/useSignals';
import type { SignalTier } from '@/types/signal';
import { formatRelativeTime } from '@/components/market-home/formatters';
import { cn } from '@/lib/utils';

export const STYLE_LABELS: Record<TradingStyle, string> = {
  scalping: 'Scalping',
  day_trading: 'Day trading',
  swing_trading: 'Swing trading',
  position_trading: 'Position trading',
};

export function directionInWords(tier: SignalTier): string {
  switch (tier) {
    case 'strong_buy':
      return 'Strongly leaning up';
    case 'buy':
      return 'Leaning up';
    case 'neutral':
      return 'No lean';
    case 'sell':
      return 'Leaning down';
    case 'strong_sell':
      return 'Strongly leaning down';
    default:
      return 'No lean';
  }
}

export interface ScoreReadingProps {
  symbol?: string;
  style?: TradingStyle;
  interval?: string;
  signal?: GlobalSignalRecord | null;
  className?: string;
}

export const ScoreReading: React.FC<ScoreReadingProps> = ({
  symbol,
  style = 'day_trading',
  interval = '1h',
  signal: propSignal,
  className,
}) => {
  const query = useLatestSignalForStyle(
    propSignal !== undefined ? null : symbol ?? null,
    propSignal !== undefined ? null : style,
    propSignal !== undefined ? null : interval
  );

  const isLoading = propSignal === undefined && query.isLoading;
  const isError = propSignal === undefined && query.isError;
  const signal = propSignal !== undefined ? propSignal : query.data?.signal;
  const styleLabel = STYLE_LABELS[style] ?? style;

  const headerChip = <EvidenceChip kind="no-edge" label="No edge (measured)" />;
  const mutedNotice = (
    <p className="text-[14px] text-muted-foreground mt-2 leading-relaxed">
      This reading is context only. The rule built on it lost after costs at every interval measured.
    </p>
  );

  if (isError) {
    return (
      <div className={cn('bg-card rounded-panel p-6 sm:p-8 flex flex-col gap-4', className)}>
        <div className="flex items-center justify-between">{headerChip}</div>
        <StateNotice
          kind="error"
          title="The score did not load."
          action={
            <button
              type="button"
              onClick={() => query.refetch()}
              className="min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[12px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px]"
            >
              Try again
            </button>
          }
        />
        {mutedNotice}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={cn('bg-card rounded-panel p-6 sm:p-8 flex flex-col gap-4', className)}>
        <div className="flex items-center justify-between">{headerChip}</div>
        <StateNotice kind="loading" title="Loading the score." />
        {mutedNotice}
      </div>
    );
  }

  if (!signal) {
    return (
      <div className={cn('bg-card rounded-panel p-6 sm:p-8 flex flex-col gap-4', className)}>
        <div className="flex items-center justify-between">{headerChip}</div>
        <StateNotice kind="empty" title="No score for this coin and interval yet." />
        {mutedNotice}
      </div>
    );
  }

  const directionText = directionInWords(signal.tier);
  const relativeTime = formatRelativeTime(
    signal.candleTimestamp || Date.parse(signal.createdAt)
  );

  return (
    <div className={cn('bg-card rounded-panel p-6 sm:p-8 flex flex-col gap-4', className)}>
      <div className="flex items-center justify-between">{headerChip}</div>

      <div className="text-[40px] md:text-[56px] font-semibold text-foreground leading-tight tracking-[-0.02em]">
        {directionText}
      </div>

      <p className="text-[15px] sm:text-[16px] text-foreground font-sans tabular-nums">
        Score {signal.score.toFixed(1)} on {interval}, {styleLabel}. Bar closed {relativeTime}.
      </p>

      {mutedNotice}
    </div>
  );
};
