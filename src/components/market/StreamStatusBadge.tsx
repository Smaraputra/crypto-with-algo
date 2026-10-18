'use client';

import type { JSX } from 'react';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { StreamStatus } from '@/lib/market-stream/client';
import { cn } from '@/lib/utils';

export interface StreamStatusBadgeProps {
  status: StreamStatus;
  lastMessageAt: number | null;
  onRetry: () => void;
  className?: string;
}

export function statusSentence(status: StreamStatus, lastMessageAt: number | null): string {
  const time =
    lastMessageAt !== null && Number.isFinite(lastMessageAt)
      ? `${new Date(lastMessageAt).toISOString().slice(11, 19)} UTC.`
      : null;

  switch (status) {
    case 'live':
      return time ? `Live prices through this site. Last update ${time}` : 'Live prices through this site.';
    case 'stale':
      return time
        ? `No new prices for over 15 seconds. Last update ${time}`
        : 'No new prices for over 15 seconds.';
    case 'connecting':
      return 'Connecting to live prices.';
    case 'reconnecting':
      return 'Connection lost. Reconnecting.';
    case 'offline':
      return 'Your device is offline.';
  }
}

const STATUS_CONFIG: Record<
  StreamStatus,
  { label: string; colorClasses: string; dot: string }
> = {
  live: {
    label: 'Live',
    colorClasses: 'border-bullish/30 bg-bullish/10 text-bullish',
    dot: 'bg-bullish',
  },
  stale: {
    label: 'Stale',
    colorClasses: 'border-accent/30 bg-accent/10 text-accent',
    dot: 'bg-accent',
  },
  connecting: {
    label: 'Connecting',
    colorClasses: 'border-accent/30 bg-accent/10 text-accent',
    dot: 'bg-accent',
  },
  reconnecting: {
    label: 'Reconnecting',
    colorClasses: 'border-accent/30 bg-accent/10 text-accent',
    dot: 'bg-accent animate-pulse',
  },
  offline: {
    label: 'Offline',
    colorClasses: 'border-bearish/30 bg-bearish/10 text-bearish',
    dot: 'bg-bearish',
  },
};

export function StreamStatusBadge({
  status,
  lastMessageAt,
  onRetry,
  className,
}: StreamStatusBadgeProps): JSX.Element {
  const config = STATUS_CONFIG[status];
  const sentence = statusSentence(status, lastMessageAt);
  const showRetry = status === 'stale' || status === 'reconnecting' || status === 'offline';

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              role="status"
              aria-live="polite"
              aria-label={config.label}
              className={cn(
                'flex items-center gap-1.5 rounded px-2 py-1 text-xs border',
                config.colorClasses
              )}
            >
              <div className={cn('h-1.5 w-1.5 rounded-full', config.dot)} />
              <span className="hidden font-medium sm:inline">{config.label}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">{sentence}</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {showRetry && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onRetry}
          aria-label="Retry live data"
        >
          <RotateCw className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
