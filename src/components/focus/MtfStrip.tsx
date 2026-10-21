'use client';

import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { useFocusMtf } from '@/hooks/useFocusMtf';
import { MTF_INTERVALS, type MtfInterval } from '@/lib/market/mtf';
import { cn } from '@/lib/utils';
import { EvidenceTag } from './EvidenceTag';
import { formatAge } from './format';

export interface MtfStripProps {
  symbol: string;
  className?: string;
}

export function MtfStrip({ symbol, className }: MtfStripProps) {
  const headingId = useId();
  const { data, isLoading, error, refetch } = useFocusMtf(symbol);

  if (isLoading) {
    return (
      <section
        aria-labelledby={headingId}
        data-testid="mtf-strip"
        className={cn('space-y-3 p-4', className)}
      >
        <div className="flex items-center justify-between">
          <h3 id={headingId} className="text-sm font-semibold">Timeframes</h3>
          <EvidenceTag kind="untested" />
        </div>
        <p role="status" className="text-sm text-muted-foreground">
          Loading timeframes...
        </p>
      </section>
    );
  }

  if (error) {
    return (
      <section
        aria-labelledby={headingId}
        data-testid="mtf-strip"
        className={cn('space-y-3 p-4', className)}
      >
        <div className="flex items-center justify-between">
          <h3 id={headingId} className="text-sm font-semibold">Timeframes</h3>
          <EvidenceTag kind="untested" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive">
            Could not load timeframes: {error.message}.
          </p>
          <Button
            variant="outline"
            size="xs"
            className="min-h-11 sm:min-h-6"
            onClick={() => void refetch()}
          >
            Retry
          </Button>
        </div>
      </section>
    );
  }

  if (!data?.states || data.states.length === 0) {
    return (
      <section
        aria-labelledby={headingId}
        data-testid="mtf-strip"
        className={cn('space-y-3 p-4', className)}
      >
        <div className="flex items-center justify-between">
          <h3 id={headingId} className="text-sm font-semibold">Timeframes</h3>
          <EvidenceTag kind="untested" />
        </div>
        <p className="text-sm text-muted-foreground">
          No timeframe data available.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="mtf-strip"
      className={cn('space-y-3 p-4', className)}
    >
      <div className="flex items-center justify-between">
        <h3 id={headingId} className="text-sm font-semibold">Timeframes</h3>
        <EvidenceTag kind="untested" />
      </div>

      <ul className="space-y-1 text-xs">
        {MTF_INTERVALS.map((interval: MtfInterval) => {
          const row = data.states.find((s) => s.interval === interval);

          if (!row || 'error' in row) {
            return (
              <li
                key={interval}
                data-testid={`mtf-row-${interval}`}
                className="flex items-center justify-between py-1 border-b border-border/50 last:border-b-0"
              >
                <span className="font-mono font-medium">{interval}</span>
                <span className="text-muted-foreground">Unavailable</span>
              </li>
            );
          }

          const trendText =
            row.trend === 1 ? 'Up' : row.trend === -1 ? 'Down' : 'No trend';
          const trendColor =
            row.trend === 1
              ? 'text-bullish'
              : row.trend === -1
              ? 'text-bearish'
              : 'text-muted-foreground';

          const eventText = row.lastEvent
            ? `${row.lastEvent.type} ${
                row.lastEvent.direction === 'bull' ? 'up' : 'down'
              }, ${formatAge(row.lastEvent.breakTimestamp)}`
            : 'None yet';

          const cvdText =
            row.cvdSlope === 'rising'
              ? 'CVD rising'
              : row.cvdSlope === 'falling'
              ? 'CVD falling'
              : row.cvdSlope === 'flat'
              ? 'CVD flat'
              : 'CVD n/a';

          const smaText =
            row.priceVsSma === 'above'
              ? 'Above 50 SMA'
              : row.priceVsSma === 'below'
              ? 'Below 50 SMA'
              : 'SMA n/a';

          return (
            <li
              key={interval}
              data-testid={`mtf-row-${interval}`}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1 border-b border-border/50 last:border-b-0"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{interval}</span>
                <span className={cn('font-medium', trendColor)}>
                  {trendText}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2.5 font-mono tabular-nums text-muted-foreground">
                <span>{eventText}</span>
                <span>{cvdText}</span>
                <span>{smaText}</span>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-muted-foreground pt-1">
        Closed bars only. A swing confirms 20 bars after it forms.
      </p>
    </section>
  );
}
