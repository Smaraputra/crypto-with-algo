'use client';

import type { TradingStyle } from '@/lib/models/signal-template';
import type { ViewTally } from '@/lib/signals/track-record/chart-data';
import type { LiveTrack, TrackRecordResponse } from '@/lib/signals/track-record/types';
import { useTrackRecord } from '@/hooks/useTrackRecord';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { CallLegend } from './CallLegend';
import {
  assessable,
  count,
  formatDate,
  MIN_SIDE_CALLS,
  netSentence,
  rightSentence,
  share,
  signed,
  STYLE_NAMES,
  verdictText,
} from './format';
import { HitRateRuler } from './HitRateRuler';
import { MonthBars } from './MonthBars';

interface TrackRecordPanelProps {
  symbol: string;
  interval: string;
  style: TradingStyle | null;
  /** Whether the symbol, style and interval form a re-scored cell. */
  eligible: boolean;
  /** State of the chart's bar requests, for the marks. */
  barsLoading: boolean;
  barsError: boolean;
  /** Calls in the chart's visible window; null until the chart reports one. */
  inView: ViewTally | null;
}

type Available = Extract<TrackRecordResponse, { available: true }>;

function Num({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('font-mono tabular-nums', className)}>{children}</span>;
}

function signClass(v: number | null): string {
  if (v === null) return 'text-foreground';
  return v < 0 ? 'text-bearish' : 'text-bullish';
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="track-record-title"
      data-testid="track-record-panel"
      className="mt-2 rounded-sm border border-border bg-card px-3 py-3 text-xs text-muted-foreground sm:px-4"
    >
      <h2 id="track-record-title" className="text-sm font-medium text-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function LiveLine({ live }: { live: LiveTrack }) {
  if (live.since === null) return <>Live record: no live bar for this symbol yet.</>;
  const since = formatDate(live.since);
  if (live.resolved === 0) {
    return (
      <>
        Live record since {since}: no call has resolved yet
        {live.pending > 0 ? <>, <Num>{count(live.pending)}</Num> still open</> : null}.
      </>
    );
  }
  const m = live.measures;
  return (
    <>
      Live record since {since}: <Num>{count(live.resolved)}</Num> resolved calls, right{' '}
      <Num>{share(m.right)}</Num>, average after costs <Num className={signClass(m.net)}>{signed(m.net)}</Num>
      {live.pending > 0 ? <>, <Num>{count(live.pending)}</Num> still open</> : null}.
      {!assessable(m) && (
        <>
          {' '}Too few to judge yet (<Num>{count(m.buyN)}</Num> buy, <Num>{count(m.sellN)}</Num> sell, the research needs{' '}
          <Num>{MIN_SIDE_CALLS}</Num> a side).
        </>
      )}
    </>
  );
}

function InViewLine({ tally }: { tally: ViewTally | null }) {
  if (!tally) return null;
  if (tally.calls === 0) return <li>On the chart now: no calls in the visible window.</li>;
  return (
    <li data-testid="track-record-in-view">
      On the chart now: <Num>{count(tally.calls)}</Num> calls, <Num>{count(tally.right)}</Num> right,{' '}
      <Num>{count(tally.won)}</Num> won after costs
      {tally.pending > 0 ? <>, <Num>{count(tally.pending)}</Num> pending</> : null}. A short window is mostly noise. The
      year above is the measure.
    </li>
  );
}

function Body({ data, inView, barsLoading, barsError }: { data: Available } & Pick<TrackRecordPanelProps, 'inView' | 'barsLoading' | 'barsError'>) {
  const { run, cell, symbol, live, boundary, liveConfigVersion } = data;
  const pooled = cell.pooled;
  const m = symbol?.measures ?? null;
  const pctLevel = `${(pooled.level * 100).toFixed(2)}%`;

  return (
    <>
      <p className="mt-0.5">
        Year figures: the version {run.configVersion} scorer re-run over{' '}
        {formatDate(symbol?.first ?? Date.parse(run.windowStart))} to {formatDate(symbol?.last ?? Date.parse(run.windowEnd))},
        each call judged {cell.horizonBars} bars later.
        {boundary !== null ? <> On the chart, the live record takes over at {formatDate(boundary)}.</> : null}
      </p>

      {run.configVersion !== liveConfigVersion && (
        <p role="note" className="mt-2 rounded-sm border border-accent/40 px-2 py-1.5 text-foreground">
          The live scorer is now version <Num>{liveConfigVersion}</Num>. This re-score describes version{' '}
          <Num>{run.configVersion}</Num>, so it no longer describes the live signal.
        </p>
      )}

      {m === null ? (
        <p className="mt-3 text-foreground">The re-score has no rows for this symbol.</p>
      ) : (
        <>
          <div className="mt-3 space-y-1" data-testid="track-record-answer">
            <p className="text-base font-medium leading-snug text-foreground sm:text-lg">{rightSentence(m, cell.costPercent)}</p>
            <p className="text-sm text-foreground">{netSentence(m)}</p>
            {!assessable(m) && (
              <p className="text-foreground">
                Too few calls to judge: <Num>{count(m.buyN)}</Num> buy and <Num>{count(m.sellN)}</Num> sell calls, under the{' '}
                <Num>{MIN_SIDE_CALLS}</Num> a side the research requires.
              </p>
            )}
          </div>

          {m.right !== null && (
            <HitRateRuler right={m.right} interval={symbol?.intervals.right ?? null} breakEven={m.breakEven} />
          )}

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
            <div>
              <dt>Calls in the year</dt>
              <dd className="mt-0.5 text-sm text-foreground">
                <Num>{count(m.calls)}</Num>
                <span className="block text-xs text-muted-foreground">
                  <Num>{count(m.buyN)}</Num> buy, <Num>{count(m.sellN)}</Num> sell
                </span>
              </dd>
            </div>
            <div>
              <dt>Buy calls right</dt>
              <dd className="mt-0.5 text-sm text-foreground">
                <Num>{share(m.buyHit)}</Num>
              </dd>
            </div>
            <div>
              <dt>Sell calls right</dt>
              <dd className="mt-0.5 text-sm text-foreground">
                <Num>{share(m.sellHit)}</Num>
                <span className="block text-xs text-muted-foreground">
                  balanced <Num>{share(m.bh)}</Num>
                </span>
              </dd>
            </div>
            <div>
              <dt>Won after costs</dt>
              <dd className="mt-0.5 text-sm text-foreground">
                <Num>{share(m.wonAfterCost)}</Num>
                <span className="block text-xs text-muted-foreground">of all calls</span>
              </dd>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <dt>Average per call</dt>
              <dd className="mt-0.5 text-sm text-foreground">
                <Num className={signClass(m.net)}>{signed(m.net)}</Num> after costs
                <span className="block text-xs text-muted-foreground">
                  <Num>{signed(m.meanBefore)}</Num> before
                  {symbol?.intervals.net ? (
                    <>
                      , 95% range <Num>{signed(symbol.intervals.net.lo)}</Num> to <Num>{signed(symbol.intervals.net.hi)}</Num>
                    </>
                  ) : null}
                </span>
              </dd>
            </div>
          </dl>

          {symbol && symbol.months.length > 0 && <MonthBars months={symbol.months} />}
        </>
      )}

      <ul className="mt-4 space-y-1.5 border-t border-border pt-3 text-foreground">
        <li>
          All ten symbols, same year: <span className="font-medium">{verdictText(pooled.verdict)}</span>. Buy and sell calls
          weighted equally, right <Num>{share(pooled.bh)}</Num> ({pctLevel} range <Num>{share(pooled.bhLo)}</Num> to{' '}
          <Num>{share(pooled.bhHi)}</Num>), average after costs <Num className={signClass(pooled.net)}>{signed(pooled.net)}</Num>.
        </li>
        <li data-testid="track-record-live">
          <LiveLine live={live} />
        </li>
        <InViewLine tally={inView} />
      </ul>

      <CallLegend />
      {barsLoading && <p className="mt-1">Loading past calls for the chart.</p>}
      {barsError && <p className="mt-1 text-foreground">Past calls could not be loaded for part of the chart. Scroll or reload to retry.</p>}

      <details className="mt-3">
        <summary className="inline-flex min-h-8 cursor-pointer items-center rounded-sm text-xs text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          How this was measured
        </summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-4">
          <li>
            Each call is judged the way the live record judges it: the spot close <Num>{cell.horizonBars}</Num> bars after the
            signal bar against the signal bar&apos;s close. A buy call is right when the price rose, a sell call when it fell.
          </li>
          <li>
            Costs are <Num>{cell.costPercent.toFixed(2)}%</Num> a round trip: the taker fee in and out plus a slippage
            allowance. A call wins after costs only when its move beats that.
          </li>
          <li>
            Break-even is the right-rate these calls would have needed, keeping their own average win and loss sizes, to end
            at zero after costs.
          </li>
          <li>
            The re-scored bars come from running the version {run.configVersion} scorer over stored candles and snapshots after
            the fact. Stored history carries no news input, so that one category is missing.{' '}
            {cell.parity.matched > 0 && cell.parity.sameTierShare !== null ? (
              <>
                Where a live bar exists for the same candle, the tiers agree on <Num>{share(cell.parity.sameTierShare)}</Num> of{' '}
                <Num>{count(cell.parity.matched)}</Num> bars.
              </>
            ) : (
              <>No live bar overlapped this cell, so the agreement could not be checked.</>
            )}
          </li>
          <li>
            The scheduler never published the re-scored calls. They are stored apart and never enter the live record, the
            calibration or the paper desk.
          </li>
          <li>
            This symbol&apos;s ranges are 95% block-bootstrap ranges (<Num>{count(run.resamples)}</Num> resamples). The
            ten-symbol verdict uses a {pctLevel} range, corrected for testing six cells at once.
          </li>
          <li>
            Rows file <Num>{run.rowsSha256.slice(0, 12)}</Num>, report <Num>{run.reportSha256.slice(0, 12)}</Num>, commit{' '}
            <Num>{run.gitCommit.slice(0, 7)}</Num>, loaded {formatDate(Date.parse(run.loadedAt))}.
          </li>
        </ul>
      </details>
    </>
  );
}

export function TrackRecordPanel({ symbol, interval, style, eligible, barsLoading, barsError, inView }: TrackRecordPanelProps) {
  const query = useTrackRecord(symbol, interval, style);
  const title = `Track record · ${symbol}${style ? ` · ${STYLE_NAMES[style]}` : ''} · ${interval}`;

  if (!eligible) {
    return (
      <Shell title="Track record">
        <p className="mt-1">
          No track record for {symbol} at {interval}. The re-score covers the ten signal symbols at 5m, 15m, 1h, 4h and 1d.
        </p>
      </Shell>
    );
  }
  if (query.isPending) {
    return (
      <Shell title={title}>
        <p className="mt-1" role="status">
          Loading the track record.
        </p>
      </Shell>
    );
  }
  if (query.isError) {
    return (
      <Shell title={title}>
        <div className="mt-1 flex flex-wrap items-center gap-2" role="alert">
          <p className="text-foreground">Could not load the track record. {query.error.message}</p>
          <Button variant="outline" size="sm" className="min-h-9" onClick={() => void query.refetch()}>
            Retry loading
          </Button>
        </div>
      </Shell>
    );
  }
  const data = query.data;
  if (!data.available) {
    return (
      <Shell title={title}>
        <p className="mt-1">
          {data.reason === 'no-run'
            ? 'The re-scored year is not loaded on this server yet (scripts/ops/load-rescore.ts loads it).'
            : `No track record for ${symbol} at ${interval}.`}
        </p>
      </Shell>
    );
  }
  return (
    <Shell title={title}>
      <Body data={data} inView={inView} barsLoading={barsLoading} barsError={barsError} />
    </Shell>
  );
}
