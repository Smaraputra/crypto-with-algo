'use client';

import React from 'react';
import { Panel } from '@/components/kit/Panel';
import { StateNotice } from '@/components/kit/StateNotice';
import { useGlobalSignals } from '@/hooks/useSignals';
import type { TradingStyle } from '@/lib/models/signal-template';
import type { GlobalSignalRecord } from '@/hooks/useSignals';
import { directionInWords } from './ScoreReading';
import { formatRelativeTime } from '@/components/market-home/formatters';

export interface ScoreHistoryProps {
  symbol?: string;
  style?: TradingStyle;
  interval?: string;
  signals?: GlobalSignalRecord[];
  className?: string;
}

export const ScoreHistory: React.FC<ScoreHistoryProps> = ({
  symbol,
  style = 'day_trading',
  interval = '1h',
  signals: propSignals,
  className,
}) => {
  const query = useGlobalSignals(
    propSignals !== undefined ? null : symbol ?? null,
    propSignals !== undefined ? null : style,
    propSignals !== undefined ? null : interval,
    20
  );

  const isLoading = propSignals === undefined && query.isLoading;
  const isError = propSignals === undefined && query.isError;
  const rawSignals = propSignals !== undefined ? propSignals : query.data?.signals;

  if (isError) {
    return (
      <Panel title="Recent readings" className={className}>
        <StateNotice kind="error" title="Could not load recent readings." />
      </Panel>
    );
  }

  if (isLoading) {
    return (
      <Panel title="Recent readings" className={className}>
        <StateNotice kind="loading" title="Loading recent readings." />
      </Panel>
    );
  }

  const rows = (rawSignals ?? []).slice(0, 20);

  if (rows.length === 0) {
    return (
      <Panel title="Recent readings" className={className}>
        <StateNotice kind="empty" title="No readings yet." />
      </Panel>
    );
  }

  return (
    <Panel title="Recent readings" className={className}>
      <div className="divide-y divide-line" role="list">
        {rows.map((sig) => {
          const timeText = formatRelativeTime(
            sig.candleTimestamp || Date.parse(sig.createdAt)
          );
          const dirWord = directionInWords(sig.tier);
          const scoreText = sig.score.toFixed(1);

          return (
            <div
              key={sig._id}
              data-testid="score-history-row"
              role="listitem"
              className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between text-[14px]"
            >
              <span className="text-muted-foreground font-sans tabular-nums text-[13px] w-24 shrink-0">
                {timeText}
              </span>
              <span className="font-medium text-foreground flex-1 px-2 truncate">
                {dirWord}
              </span>
              <span className="font-sans tabular-nums font-semibold text-foreground text-right w-16 shrink-0">
                {scoreText}
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
};
