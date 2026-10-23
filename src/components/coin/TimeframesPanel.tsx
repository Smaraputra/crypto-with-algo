'use client';

import React from 'react';
import { Panel } from '@/components/kit/Panel';
import { EvidenceChip } from '@/components/kit/EvidenceChip';
import { useFocusMtf } from '@/hooks/useFocusMtf';
import { MTF_INTERVALS, type MtfInterval, type MtfState } from '@/lib/market/mtf';
import type { StructureEvent } from '@/lib/market/structure';
import { formatRelativeTime } from '@/components/market-home/formatters';
import { cn } from '@/lib/utils';

export interface TimeframesPanelProps {
  symbol: string;
  className?: string;
}

export function formatStructureEvent(
  event: StructureEvent | null | undefined,
  now = Date.now()
): string {
  if (!event) return 'No event';
  const typeWord = event.type === 'BOS' ? 'Break' : 'Change of character';
  const dirWord = event.direction === 'bull' ? 'up' : 'down';
  const timeAgo = formatRelativeTime(event.breakTimestamp, now);
  return `${typeWord} ${dirWord}, ${timeAgo}`;
}

export function formatTrend(trend: number | undefined): string {
  if (trend === 1) return 'Up';
  if (trend === -1) return 'Down';
  return 'No trend';
}

export function formatCvd(slope: string | null | undefined): string {
  if (slope === 'rising') return 'CVD rising';
  if (slope === 'falling') return 'CVD falling';
  return 'CVD flat';
}

export function formatSma(vsSma: string | null | undefined): string {
  if (vsSma === 'below') return 'Below 50 SMA';
  return 'Above 50 SMA';
}

export const TimeframesPanel: React.FC<TimeframesPanelProps> = ({ symbol, className }) => {
  const { data } = useFocusMtf(symbol);

  const states = data?.states;

  return (
    <Panel
      title="Timeframes"
      action={<EvidenceChip kind="untested" />}
      className={className}
    >
      <div className="divide-y divide-line">
        {MTF_INTERVALS.map((interval: MtfInterval) => {
          const row = states?.find((s) => s.interval === interval);
          const isError = !row || ('error' in row && row.error);

          if (isError) {
            return (
              <div
                key={interval}
                data-testid={`timeframe-row-${interval}`}
                className="py-3 first:pt-0 last:pb-0 flex items-center justify-between text-[14px]"
              >
                <span className="font-semibold text-foreground font-sans tabular-nums w-12">
                  {interval}
                </span>
                <span className="text-muted-foreground">Did not load.</span>
              </div>
            );
          }

          const state = row as MtfState;
          const trendWord = formatTrend(state.trend);
          const eventWord = formatStructureEvent(state.lastEvent);
          const cvdWord = formatCvd(state.cvdSlope);
          const smaWord = formatSma(state.priceVsSma);

          return (
            <div
              key={interval}
              data-testid={`timeframe-row-${interval}`}
              className="py-3 first:pt-0 last:pb-0 flex flex-col gap-1 text-[14px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-foreground font-sans tabular-nums w-12">
                  {interval}
                </span>
                <span
                  className={cn(
                    'font-medium',
                    trendWord === 'Up'
                      ? 'text-up'
                      : trendWord === 'Down'
                        ? 'text-down'
                        : 'text-muted-foreground'
                  )}
                >
                  {trendWord}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 text-[13px] text-muted-foreground flex-wrap">
                <span>{eventWord}</span>
                <div className="flex items-center gap-2">
                  <span>{cvdWord}</span>
                  <span aria-hidden="true">&middot;</span>
                  <span>{smaWord}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[13px] text-muted-foreground mt-4 leading-normal border-t border-line pt-3">
        Closed bars only. A swing confirms 20 bars after it forms.
      </p>
    </Panel>
  );
};
