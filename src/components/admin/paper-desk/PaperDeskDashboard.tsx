'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EquityCurveChart } from '@/components/backtest/EquityCurveChart';
import { cn } from '@/lib/utils';
import { usePaperDesk, type PaperDeskBook } from '@/hooks/usePaperDesk';
import { describeReadRule } from '@/lib/paper-desk/report';

function pct(value: number | null, digits = 4): string {
  if (value === null) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bullish' | 'bearish' }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'font-mono tabular-nums text-sm',
          tone === 'bullish' && 'text-bullish',
          tone === 'bearish' && 'text-bearish'
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function BookPanel({ book }: { book: PaperDeskBook }) {
  const { engine, executable } = book;

  return (
    <Card data-testid={`paper-desk-book-${book.book}`}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">{book.book}</CardTitle>
          <span className="text-xs text-muted-foreground">
            {book.trades} closed, {book.openPositions} open, {book.symbols} ledgers
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p
          className={cn(
            'text-xs',
            book.readRule.futility
              ? 'text-bearish'
              : book.readRule.goLive === 'pass'
                ? 'text-bullish'
                : 'text-muted-foreground'
          )}
          data-testid={`paper-desk-read-rule-${book.book}`}
        >
          Read rule: {describeReadRule(book.readRule)}
        </p>
        {book.trades === 0 ? (
          <p className="text-sm text-muted-foreground">
            No closed trades yet. {book.missingScoreBars} bars stepped with at least one symbol unscored.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Engine, per trade"
                value={pct(engine!.expectancyPercent)}
                tone={engine!.expectancyPercent >= 0 ? 'bullish' : 'bearish'}
              />
              <Stat
                label="Engine 95% CI"
                value={`${pct(engine!.ciLowPercent, 3)} to ${pct(engine!.ciHighPercent, 3)}`}
              />
              <Stat
                label="Executable, per trade"
                value={executable ? pct(executable.expectancyPercent) : 'n/a'}
                tone={
                  executable && executable.expectancyPercent >= 0 ? 'bullish' : executable ? 'bearish' : undefined
                }
              />
              <Stat label="Lag cost" value={pct(book.lagCostPercent)} />
              <Stat label="Win rate (descriptive)" value={`${(engine!.winRate * 100).toFixed(1)}%`} />
              <Stat label="Recorded" value={pct(book.recordedExpectancyPercent)} />
              <Stat label="Peak leverage" value={`${book.peakLeverage.toFixed(2)}x`} />
              <Stat
                label="Equity"
                value={`${book.equity.toFixed(2)} of ${book.startEquity.toFixed(0)}`}
                tone={book.equity >= book.startEquity ? 'bullish' : 'bearish'}
              />
            </dl>

            <p className="text-xs text-muted-foreground">
              Exits: {Object.entries(book.byReason).map(([k, v]) => `${k} ${v}`).join(', ')}. Execution:{' '}
              {book.gappedStops} gapped stops, {book.stoppedOnArrival} stopped on arrival, {book.unfilled}{' '}
              never filled. Evidence for this interval is {book.evidenceStatus}.
            </p>

            <div data-testid={`paper-desk-curve-${book.book}`}>
              <EquityCurveChart equityCurve={book.engineCurve} startEquity={book.startEquity} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function PaperDeskDashboard() {
  const { data, isLoading, isError } = usePaperDesk();

  if (isLoading) {
    return <div className="h-32 animate-pulse rounded bg-muted" data-testid="paper-desk-loading" />;
  }
  if (isError || !data) {
    return <p className="text-sm text-muted-foreground">The paper desk record is unavailable.</p>;
  }

  return (
    <div className="space-y-4" data-testid="paper-desk-dashboard">
      {data.books.map((book) => (
        <BookPanel key={book.book} book={book} />
      ))}
    </div>
  );
}
