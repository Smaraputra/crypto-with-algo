'use client';

import { MARKET_SESSIONS, SESSION_LABELS, type MarketSession } from '@/lib/sessions';
import { cn } from '@/lib/utils';
import type {
  SessionPerformance,
  HourPerformance,
  WeekdayPerformance,
} from '@/types/journal-analytics';

import { formatWinRate } from './format';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface TimingAnalyticsProps {
  bySession: SessionPerformance[];
  byHour: HourPerformance[];
  byWeekday: WeekdayPerformance[];
}

function PnlValue({ value }: { value: number }) {
  return (
    <span
      className={cn(
        'font-mono tabular-nums',
        value >= 0 ? 'text-bullish' : 'text-bearish'
      )}
    >
      {value >= 0 ? '+' : ''}
      {value.toFixed(2)}%
    </span>
  );
}

export function TimingAnalytics({ bySession, byHour, byWeekday }: TimingAnalyticsProps) {
  if (bySession.length === 0 && byHour.length === 0 && byWeekday.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="timing-empty">
        No closed trades yet. Timing analytics appear once trades have P&L data.
      </p>
    );
  }

  const sessionOrder = new Map(MARKET_SESSIONS.map((s, i) => [s as string, i]));
  const sortedSessions = [...bySession].sort(
    (a, b) => (sessionOrder.get(a.session) ?? 99) - (sessionOrder.get(b.session) ?? 99)
  );

  return (
    <div className="grid gap-4 lg:grid-cols-3" data-testid="timing-analytics">
      <div>
        <h4 className="mb-2 text-xs font-medium text-muted-foreground">By Session (UTC)</h4>
        <ul className="space-y-1.5">
          {sortedSessions.map((entry) => (
            <li key={entry.session} className="flex items-center justify-between text-xs">
              <span>{SESSION_LABELS[entry.session as MarketSession] ?? entry.session}</span>
              <span className="flex items-center gap-3">
                <span className="text-muted-foreground">{entry.count} trades</span>
                <span className="font-mono tabular-nums">{formatWinRate(entry.winRate, 0)}</span>
                <PnlValue value={entry.avgPnlPercent} />
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-medium text-muted-foreground">By Hour (UTC)</h4>
        <ul className="space-y-1.5">
          {byHour.map((entry) => (
            <li key={entry.hour} className="flex items-center justify-between text-xs">
              <span className="font-mono tabular-nums">
                {String(entry.hour).padStart(2, '0')}:00
              </span>
              <span className="flex items-center gap-3">
                <span className="text-muted-foreground">{entry.count} trades</span>
                <span className="font-mono tabular-nums">{formatWinRate(entry.winRate, 0)}</span>
                <PnlValue value={entry.avgPnlPercent} />
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-medium text-muted-foreground">By Weekday (UTC)</h4>
        <ul className="space-y-1.5">
          {byWeekday.map((entry) => (
            <li key={entry.weekday} className="flex items-center justify-between text-xs">
              <span>{WEEKDAY_LABELS[entry.weekday] ?? entry.weekday}</span>
              <span className="flex items-center gap-3">
                <span className="text-muted-foreground">{entry.count} trades</span>
                <span className="font-mono tabular-nums">{formatWinRate(entry.winRate, 0)}</span>
                <PnlValue value={entry.avgPnlPercent} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
