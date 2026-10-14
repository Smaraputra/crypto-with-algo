'use client';

import { useId, useState, type ReactNode } from 'react';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useCrossSectionalLatest } from '@/hooks/useSignals';
import { cn } from '@/lib/utils';
import type { RvValidationStatus } from '@/lib/models/rv-book';
import type { RvSkipReason } from '@/lib/signals/cross-sectional/engine';
import {
  isPendingStep,
  makerFillRate,
  pendingReasonLabel,
  positionRows,
  raisedAlertKinds,
  type RvAlertKind,
  type RvBookView,
  type RvLatestResponse,
  type RvLegacyBookView,
  type RvPositionRow,
  type RvSignalView,
  type RvStepView,
} from '@/lib/paper-desk/rv-latest';

const TITLE = '8h Relative Value, rv-v1';

// The shared button's half-opacity ring is 2.9:1 on the card, the full ring is 8.4:1.
// It also has no pressed state, so a press shrinks the button slightly.
const BUTTON_STATES = 'focus-visible:ring-ring active:scale-[0.98] motion-reduce:active:scale-100';

// ---------------------------------------------------------------- formats

function utcTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A timestamp inside a sentence, kept on one line so the date never splits at its hyphens. */
function Stamp({ ms }: { ms: number }) {
  return <span className="whitespace-nowrap">{utcTime(ms)}</span>;
}

function utcDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function usd(value: number): string {
  return `$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Cents-rounded and signed, so a change that rounds to zero reads $0.00, never -$0.00. */
function signedUsd(value: number): string {
  const cents = Math.round(value * 100);
  if (cents === 0) return '$0.00';
  return `${cents > 0 ? '+' : '-'}${usd(cents / 100)}`;
}

function signedPercent(fraction: number): string {
  const text = Math.abs(fraction * 100).toFixed(2);
  if (text === '0.00') return '0.00%';
  return `${fraction > 0 ? '+' : '-'}${text}%`;
}

function signed(value: number): string {
  const text = value.toFixed(2);
  return value > 0 && text !== '0.00' ? `+${text}` : text;
}

/** Enough decimals to show the tick that matters at each price level. */
function price(value: number): string {
  const decimals = value >= 100 ? 2 : value >= 10 ? 3 : value >= 1 ? 4 : 5;
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function bps(rate: number): string {
  return String(Number((rate * 1e4).toFixed(2)));
}

function wholePercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function base(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

function changeTone(value: number): string {
  const cents = Math.round(value * 100);
  if (cents > 0) return 'text-bullish';
  if (cents < 0) return 'text-bearish';
  return 'text-muted-foreground';
}

const STATUS: Record<RvValidationStatus, { label: string; tone: string }> = {
  // The accent, not the bearish red: the rule is untested, not failing
  unvalidated: { label: 'Not validated', tone: 'border-accent/60 bg-accent/10 text-accent' },
  validated: { label: 'Validated', tone: 'border-bullish/50 bg-bullish/10 text-bullish' },
  rejected: { label: 'Rejected', tone: 'border-bearish/50 bg-bearish/10 text-bearish' },
};

function subtitle(book: RvBookView): string {
  const since = `Descriptive forward record since ${utcDate(book.startedAt)}.`;
  if (book.validationStatus === 'validated') {
    const ref = book.validationRef ? `Validated, see ${book.validationRef}.` : 'Validated.';
    return `${since} ${ref} Paper only.`;
  }
  if (book.validationStatus === 'rejected') {
    const ref = book.validationRef ? `Rejected by re-validation, see ${book.validationRef}.` : 'Rejected by re-validation.';
    return `${since} ${ref} Paper only.`;
  }
  return `Experimental. ${since} Not validated. Paper only.`;
}

const SKIP_REASON: Record<RvSkipReason, string> = {
  bars_incomplete: 'bars incomplete',
  bars_not_contiguous: 'bars not contiguous',
  carry_missing: 'no funding settlement',
  carry_stale: 'funding settlement stale',
  flow_missing: 'taker volume missing',
};

const ALERT_SHORT: Record<RvAlertKind, string> = {
  drawdown_taker: 'taker drawdown',
  drawdown_maker: 'maker drawdown',
  negative_streak: 'negative streak',
};

// ------------------------------------------------------------------ parts

/**
 * Each state renders its own keyed Shell, so React mounts fresh nodes instead
 * of moving a reused skeleton node into place, which counts as a layout shift.
 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <Card className="gap-4 py-4 sm:gap-5 sm:py-5" data-testid="rv-desk-card">
      {children}
    </Card>
  );
}

function TitleRow({ status, asOf }: { status: RvValidationStatus | null; asOf?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <h2 className="text-base font-semibold leading-tight">{TITLE}</h2>
      {status && (
        <span
          className={cn('rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-5', STATUS[status].tone)}
        >
          {STATUS[status].label}
        </span>
      )}
      {asOf && (
        <p className="w-full font-mono text-xs tabular-nums text-muted-foreground sm:ml-auto sm:w-auto">{asOf}</p>
      )}
    </div>
  );
}

function TrackPanel({
  name,
  equity,
  change,
  cost,
  children,
}: {
  name: string;
  equity: number;
  change: number;
  cost: string;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border px-3 py-2.5" aria-label={name}>
      <h3 className="text-xs font-medium text-muted-foreground">{name}</h3>
      <p className="mt-1 font-mono text-xl font-semibold tabular-nums">{usd(equity)}</p>
      <p className={cn('font-mono text-xs tabular-nums', changeTone(change))}>{signedUsd(change)} since start</p>
      <p className="mt-2 text-xs text-muted-foreground">{cost}</p>
      {children}
    </section>
  );
}

function MakerFillLine({ book }: { book: RvBookView }) {
  const { filled, fallback, rate } = makerFillRate(book.fillStats);
  let text: string;
  if (rate === null) text = 'No maker fills yet';
  else if (filled === 0) text = `No maker fills yet, ${fallback} ${fallback === 1 ? 'order' : 'orders'} fell back to taker`;
  else text = `Maker fill rate ${wholePercent(rate)} (${filled} of ${filled + fallback} orders)`;
  return <p className="mt-1 text-xs text-foreground">{text}</p>;
}

function WaitingOnData({ step }: { step: RvStepView }) {
  const headingId = useId();
  const labels = [...new Set(step.pendingReasons.map(pendingReasonLabel))];
  return (
    <section aria-labelledby={headingId} className="space-y-2 rounded-md border border-border-strong bg-muted/40 px-3 py-2.5">
      <h3 id={headingId} className="text-sm font-medium">
        Waiting on data
      </h3>
      <p className="text-xs text-muted-foreground">
        The step for the bar closing <Stamp ms={step.fillTime} /> is pending. The desk retries it on every run.
      </p>
      <ul className="flex flex-wrap gap-1.5" aria-label="Pending reasons">
        {labels.map((label) => (
          <li key={label} className="rounded border border-border-strong px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {label}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">The figures below are from the last completed step.</p>
    </section>
  );
}

function Flags({ data }: { data: RvLatestResponse & { book: RvBookView } }) {
  const { book, lastAlert, rule } = data;
  const kinds = raisedAlertKinds(book.alerts);
  if (kinds.length === 0) {
    if (!lastAlert) return null;
    return (
      <p className="text-xs text-muted-foreground">
        No flag raised now. Last flagged <Stamp ms={lastAlert.fillTime} /> ({lastAlert.kinds.map((k) => ALERT_SHORT[k]).join(', ')}).
      </p>
    );
  }
  const drawdown = wholePercent(rule.drawdownFlag);
  const text: Record<RvAlertKind, string> = {
    drawdown_taker: `Taker track ${drawdown} or more below its peak`,
    drawdown_maker: `Maker track ${drawdown} or more below its peak`,
    negative_streak: `Taker equity lower for ${book.alerts.negativeStreak} steps in a row`,
  };
  return (
    <div className="space-y-1.5">
      <ul className="flex flex-wrap gap-1.5" aria-label="Raised flags">
        {kinds.map((kind) => (
          <li key={kind} className="rounded-md border border-bearish/50 bg-bearish/10 px-2 py-0.5 text-xs font-medium text-bearish">
            {text[kind]}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">Flags are descriptive. The desk keeps trading.</p>
    </div>
  );
}

function MobileLabel({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className="block text-[11px] text-muted-foreground md:hidden">
      {children}
    </span>
  );
}

function PositionsTable({ rows, headingId }: { rows: RvPositionRow[]; headingId: string }) {
  const th = 'px-3 py-2 font-medium';
  // Below md (768px) each row reflows into a two-column block with its own labels, because six numeric columns crowd a 640px card
  const cell = 'md:table-cell md:px-3 md:py-2';
  const right = 'text-right md:text-right';
  return (
    <table aria-labelledby={headingId} className="block w-full text-left text-xs md:table">
      <thead className="sr-only border-b border-border bg-muted/50 text-muted-foreground md:not-sr-only md:table-header-group">
        <tr>
          <th scope="col" className={th}>Position</th>
          <th scope="col" className={cn(th, 'text-right')}>Weight</th>
          <th scope="col" className={cn(th, 'text-right')}>Entry</th>
          <th scope="col" className={cn(th, 'text-right')}>Last price</th>
          <th scope="col" className={cn(th, 'text-right')}>Unrealized, taker</th>
          <th scope="col" className={cn(th, 'text-right')}>Unrealized, maker</th>
        </tr>
      </thead>
      <tbody className="block divide-y divide-border md:table-row-group">
        {rows.map((row) => (
          <tr key={row.symbol} className="grid grid-cols-2 gap-x-3 gap-y-2 py-2.5 md:table-row md:py-0">
            <td className={cell}>
              <span className="flex flex-wrap items-center gap-1.5">
                <span
                  className={cn(
                    'rounded-sm px-1.5 py-0.5 text-[11px] font-semibold',
                    row.side === 'long' ? 'bg-bullish/15 text-bullish' : 'bg-bearish/15 text-bearish'
                  )}
                >
                  {row.side === 'long' ? 'Long' : 'Short'}
                </span>
                <span className="font-medium">{base(row.symbol)}</span>
                {row.stale && (
                  <span className="rounded-sm border border-border-strong px-1.5 text-[11px] text-foreground">Stale</span>
                )}
                {row.makerOnly && (
                  <span className="rounded-sm border border-border-strong px-1.5 text-[11px] text-foreground">
                    Maker track only
                  </span>
                )}
              </span>
            </td>
            <td className={cn(cell, right)}>
              <MobileLabel>Weight</MobileLabel>
              <span className="font-mono tabular-nums">{signedPercent(row.weight)}</span>
            </td>
            <td className={cn(cell, 'md:text-right')}>
              <MobileLabel>Entry</MobileLabel>
              <span className="font-mono tabular-nums">{price(row.entry)}</span>
            </td>
            <td className={cn(cell, right)}>
              <MobileLabel>Last price</MobileLabel>
              <span className="font-mono tabular-nums">{price(row.lastPrice)}</span>
            </td>
            <td className={cn(cell, 'md:text-right')}>
              <MobileLabel>Unrealized, taker</MobileLabel>
              <Change value={row.unrealizedTaker} />
            </td>
            <td className={cn(cell, right)}>
              <MobileLabel>Unrealized, maker</MobileLabel>
              <Change value={row.unrealizedMaker} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">Not held</span>;
  return <span className={cn('font-mono tabular-nums', changeTone(value))}>{signedUsd(value)}</span>;
}

function Positions({ book, completedStep }: { book: RvBookView; completedStep: RvStepView | null }) {
  const headingId = useId();
  const rows = positionRows(book, completedStep);
  const skipped = [
    ...new Set([...(completedStep?.taker?.skippedEntries ?? []), ...(completedStep?.maker?.skippedEntries ?? [])]),
  ];
  return (
    <section className="space-y-2">
      <h3 id={headingId} className="text-sm font-medium">
        Positions
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No open positions.</p>
      ) : (
        <div className="rounded-md border border-border px-3 md:px-0">
          <PositionsTable rows={rows} headingId={headingId} />
        </div>
      )}
      {rows.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Weight and entry come from the taker track. Last price is the perp open the last step marked at.
        </p>
      )}
      {rows.some((r) => r.stale) && (
        <p className="text-xs text-muted-foreground">
          Stale: no 1h perp bar at the last step, so the last price is from an earlier step.
        </p>
      )}
      {skipped.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Not entered at the last step (no 1h perp bar): {skipped.map(base).join(', ')}.
        </p>
      )}
    </section>
  );
}

function Ranking({ signal, rule }: { signal: RvSignalView | null; rule: RvLatestResponse['rule'] }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const w = rule.weights;
  const scoring = (
    <p className="text-xs text-muted-foreground">
      Composite of four z-scores: momentum {wholePercent(w.mom)}, residual momentum {wholePercent(w.idio)}, carry{' '}
      {wholePercent(w.carry)}, taker flow {wholePercent(w.flow)}. Carry = minus the latest settled funding rate.
    </p>
  );
  if (!signal) {
    return (
      <section className="space-y-1.5">
        {scoring}
        <p className="text-xs text-muted-foreground">No rv-v1 signal stored yet.</p>
      </section>
    );
  }
  const betas = new Map(signal.rows.map((r) => [r.symbol, r]));
  const closing = utcTime(signal.barCloseTime);
  return (
    <section className="space-y-1.5">
      {scoring}
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((prev) => !prev)}
        className={cn('h-auto min-h-11 whitespace-normal py-1.5 text-left text-xs sm:min-h-8', BUTTON_STATES)}
      >
        {open ? (
          'Hide the ranking'
        ) : (
          <span>
            Show the ranking for the bar closing <Stamp ms={signal.barCloseTime} />
          </span>
        )}
      </Button>
      <div id={regionId} hidden={!open} className="space-y-1.5">
        <div
          className="overflow-x-auto rounded-md border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          tabIndex={0}
          role="region"
          aria-label="Ranking table"
        >
          <table aria-label={`Ranking for the bar closing ${closing}`} className="w-full min-w-[34rem] text-left text-xs">
            <thead className="border-b border-border bg-muted/50 text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Rank</th>
                <th scope="col" className="px-3 py-2 font-medium">Symbol</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Composite</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Momentum</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Residual</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Carry</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Flow</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Beta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {signal.ranked.map((r) => {
                const row = betas.get(r.symbol);
                return (
                  <tr key={r.symbol}>
                    <td className="px-3 py-1.5 font-mono tabular-nums">{r.rank}</td>
                    <td className="px-3 py-1.5 font-medium">{base(r.symbol)}</td>
                    <td className={cn('px-3 py-1.5 text-right font-mono font-semibold tabular-nums', changeTone(r.compositeZ))}>
                      {signed(r.compositeZ)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{row ? signed(row.zMom) : 'Missing'}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{row ? signed(row.zIdio) : 'Missing'}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{row ? signed(row.zCarry) : 'Missing'}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{row ? signed(row.zFlow) : 'Missing'}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{row ? row.beta.toFixed(2) : 'Missing'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {signal.skipped.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Not scored for this bar: {signal.skipped.map((s) => `${base(s.symbol)} (${SKIP_REASON[s.reason]})`).join(', ')}.
          </p>
        )}
      </div>
    </section>
  );
}

function LegacyNote({ legacy }: { legacy: RvLegacyBookView | null }) {
  if (!legacy) return null;
  return (
    <p className="border-t border-border pt-3 text-[11px] text-muted-foreground">
      Archived: book {legacy.bookName} (spot prices, pre-rv-v1 rules) is read-only and no longer stepped.{' '}
      {legacy.lastProcessedBarTime === null ? (
        'It never processed a signal'
      ) : (
        <>
          Last signal processed <Stamp ms={legacy.lastProcessedBarTime} />
        </>
      )}
      , taker {usd(legacy.equityTaker)}, maker {usd(legacy.equityMaker)}.
    </p>
  );
}

// ------------------------------------------------------------------- card

/**
 * The rv-v1 paper desk on the dashboard: a descriptive forward record of an
 * unvalidated rule on Binance USDT-M perp prices, two cost tracks side by
 * side. Every figure comes from the book and its last completed step, never
 * from the latest signal's targets.
 */
export function CrossSectionalPortfolioCard() {
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useCrossSectionalLatest();

  if (isLoading) {
    return (
      <Shell key="loading">
        <CardHeader className="gap-1.5 px-4 sm:px-6">
          <TitleRow status={null} />
          <div aria-hidden="true" className="h-5 w-3/4 rounded bg-muted animate-shimmer" />
          <div aria-hidden="true" className="h-8 w-2/3 rounded bg-muted animate-shimmer sm:h-4" />
        </CardHeader>
        {/* Blocks sized like the loaded card, so the page below does not jump when it arrives */}
        <CardContent className="space-y-5 px-4 sm:px-6">
          <p role="status" className="sr-only">
            Loading the rv-v1 paper desk
          </p>
          <div aria-hidden="true" className="grid gap-3 sm:grid-cols-2">
            <div className="h-32 rounded-md bg-muted animate-shimmer" />
            <div className="h-32 rounded-md bg-muted animate-shimmer" />
          </div>
          <div aria-hidden="true" className="h-[32rem] rounded-md bg-muted animate-shimmer md:h-64" />
          <div aria-hidden="true" className="h-24 rounded-md bg-muted animate-shimmer" />
        </CardContent>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell key="error">
        <CardHeader className="px-4 sm:px-6">
          <TitleRow status={null} />
        </CardHeader>
        <CardContent className="space-y-3 px-4 sm:px-6">
          <p role="alert" className="text-sm">
            Could not load the rv-v1 paper desk: {error?.message ?? 'the request returned no data'}.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn('h-11 sm:h-8', BUTTON_STATES)}
            onClick={() => void refetch()}
          >
            Retry
          </Button>
        </CardContent>
      </Shell>
    );
  }

  const { book, completedStep, step } = data;
  const refreshFailed = isError && (
    <p role="alert" className="text-xs text-muted-foreground">
      Refresh failed ({error?.message ?? 'unknown error'}). Showing data loaded at <Stamp ms={dataUpdatedAt} />.
    </p>
  );

  if (!book) {
    return (
      <Shell key="empty">
        <CardHeader className="gap-1.5 px-4 sm:px-6">
          <TitleRow status={null} />
          <p className="text-sm">Experimental. Paper only.</p>
        </CardHeader>
        <CardContent className="space-y-3 px-4 sm:px-6">
          {refreshFailed}
          <p className="text-sm text-muted-foreground">
            No rv-v1 book yet. The paper desk creates it on its first run, at 01:05, 09:05 or 17:05 UTC.
          </p>
          <LegacyNote legacy={data.legacy} />
        </CardContent>
      </Shell>
    );
  }

  const pending = step && isPendingStep(step, book.lastStepBarTime) ? step : null;
  const asOf = completedStep ? `As of ${utcTime(completedStep.fillTime)}` : 'No completed step yet';
  const start = data.rule.startingEquity;

  return (
    <Shell key="desk">
      <CardHeader className="gap-1.5 px-4 sm:px-6">
        <TitleRow status={book.validationStatus} asOf={asOf} />
        <p className="text-sm text-pretty">{subtitle(book)}</p>
        <p className="text-xs text-pretty text-muted-foreground">
          Binance USDT-M perp prices. Long the top {data.rule.legs}, short the bottom {data.rule.legs}, beta-neutral,
          rebalanced at the 00:00, 08:00 and 16:00 UTC bar closes.
        </p>
      </CardHeader>
      <CardContent className="space-y-5 px-4 sm:px-6">
        {refreshFailed}
        {pending && <WaitingOnData step={pending} />}
        <Flags data={{ ...data, book }} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TrackPanel
            name="Taker track"
            equity={book.equity.taker}
            change={book.equity.taker - start}
            cost={`Taker ${bps(data.costs.takerFee)} bps + ${data.costs.takerSlippageBps} bps slippage`}
          />
          <TrackPanel
            name="Maker track"
            equity={book.equity.maker}
            change={book.equity.maker - start}
            cost={`Maker ${bps(data.costs.makerFee)} bps (fills only if the first hour trades through the open, else taker)`}
          >
            <MakerFillLine book={book} />
          </TrackPanel>
        </div>
        <Positions book={book} completedStep={completedStep} />
        <Ranking signal={data.signal} rule={data.rule} />
        <LegacyNote legacy={data.legacy} />
      </CardContent>
    </Shell>
  );
}
