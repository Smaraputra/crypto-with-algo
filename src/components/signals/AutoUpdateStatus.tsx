'use client';

import { useEffect, useState } from 'react';

import type { TradingStyle } from '@/lib/models/signal-template';
import { STYLE_CONFIGS } from '@/lib/indicators/style-configs';

interface AutoUpdateStatusProps {
  tradingStyle: TradingStyle;
  lastUpdated: string | null; // ISO date string
}

function formatRelativeTime(nowMs: number, dateStr: string): string {
  const diffMs = nowMs - new Date(dateStr).getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

export function AutoUpdateStatus({ tradingStyle, lastUpdated }: AutoUpdateStatusProps) {
  const [now, setNow] = useState(() => Date.now());
  const updateFreqMs = STYLE_CONFIGS[tradingStyle].updateFrequencyMs;

  // Tick every second to refresh relative times
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, []);

  if (!lastUpdated) {
    return (
      <div className="text-xs text-muted-foreground" data-testid="auto-update-status">
        No signals computed yet
      </div>
    );
  }

  const lastTime = new Date(lastUpdated).getTime();
  const nextUpdateMs = lastTime + updateFreqMs - now;

  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      data-testid="auto-update-status"
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{
          backgroundColor: nextUpdateMs <= 0 ? 'var(--bullish)' : 'var(--signal-neutral)',
        }}
      />
      <span>Last: {formatRelativeTime(now, lastUpdated)}</span>
      <span className="text-border">|</span>
      <span>
        Next: {formatCountdown(nextUpdateMs)}
      </span>
    </div>
  );
}
