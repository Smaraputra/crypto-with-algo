'use client';

import type { ReactNode } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { REGIME_EVIDENCE, type VolatilityRegime } from '@/lib/costs/volatility-regime';
import { cn } from '@/lib/utils';

interface VolatilityRegimeCardProps {
  /** Undefined while loading or on error; null when the venue's bars were incomplete. */
  regime: VolatilityRegime | null | undefined;
  isLoading: boolean;
  /** Why the regime is missing, when the request failed. */
  problem: string | null;
}

function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono tabular-nums', className)}>{children}</span>;
}

function wholePercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function monthYear(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Whether yesterday was a high-volatility day for the market (BTCUSDT), and
 * what that has meant for the next day. Volatility, never direction: a high
 * day is shown in the accent tone, not as good or bad.
 */
export function VolatilityRegimeCard({ regime, isLoading, problem }: VolatilityRegimeCardProps) {
  const e = REGIME_EVIDENCE;
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-sm">Market volatility</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm" data-testid="cost-check-regime">
        {regime ? (
          <>
            <p className="max-w-prose">
              <span className={cn('font-semibold', regime.high ? 'text-accent' : 'text-foreground')}>
                {regime.high ? 'High.' : 'Normal.'}
              </span>{' '}
              BTC&apos;s realised volatility on {new Date(regime.day).toISOString().slice(0, 10)} (UTC) was{' '}
              <Num>{regime.dayVolPercent.toFixed(2)}%</Num>, {regime.high ? 'at or above' : 'below'} the{' '}
              <Num>{regime.thresholdVolPercent.toFixed(2)}%</Num> that marks the top fifth of the previous{' '}
              <Num>{regime.trailingDays}</Num> days, and higher than on <Num>{Math.round(regime.percentile)}%</Num>{' '}
              of them.
            </p>
            <p className="text-muted-foreground max-w-prose text-xs">
              After a top-fifth day, the next day was also in the top fifth <Num>{wholePercent(e.highAfterHigh)}</Num> of
              the time, against <Num>{wholePercent(e.highAfterOther)}</Num> after other days ({e.symbol},{' '}
              {monthYear(e.from)} to {monthYear(e.to)}). A high day means larger moves than the typical one above, in
              either direction.
            </p>
          </>
        ) : isLoading ? (
          <p className="text-muted-foreground">Reading BTC&apos;s hourly bars for the last 181 days.</p>
        ) : problem ? (
          <p className="text-muted-foreground">Not available: {problem}.</p>
        ) : (
          <p className="text-muted-foreground">Not measured: BTC&apos;s hourly bars for yesterday are incomplete.</p>
        )}
      </CardContent>
    </Card>
  );
}
