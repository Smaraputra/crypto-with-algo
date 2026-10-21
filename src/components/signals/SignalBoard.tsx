'use client';

import { useId, useState } from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSignalLab } from '@/hooks/useSignalLab';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import {
  LAB_HYPOTHESES_V1,
  type LabCandidateId,
  type LabTimeframe,
} from '@/lib/signals/lab/candidates';
import type { LabHypothesisView, LabStatus } from '@/lib/signals/lab/view';
import { LabV2Section } from './LabV2Section';
import { LabV3Section } from './LabV3Section';

const L2_TIMEFRAMES: readonly LabTimeframe[] = ['5m', '15m', '1h', '4h', '1d'];

const SECTION3_HYPOTHESES: readonly { candidate: LabCandidateId; timeframe: LabTimeframe }[] = [
  { candidate: 'L1', timeframe: '8h' },
  { candidate: 'L3', timeframe: '8h' },
  { candidate: 'L4', timeframe: '8h' },
];

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toISOString().slice(0, 10);
}

export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return 'n/a';
  try {
    return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  } catch {
    return 'n/a';
  }
}

export function getStatusText(hyp: {
  status: LabStatus;
  underTestSince: string | null;
  validatedAt: string | null;
  testEndsAt: string | null;
}): string {
  switch (hyp.status) {
    case 'not_started':
      return 'Not started';
    case 'under_test':
      return `Under test since ${formatDate(hyp.underTestSince)}`;
    case 'validated':
      return `Validated (forward, ${formatDate(hyp.validatedAt)})`;
    case 'not_shown':
      return `Not shown (test ended ${formatDate(hyp.testEndsAt)})`;
    default:
      return 'Not started';
  }
}

function hypothesisName(candidate: string, timeframe: string): string {
  switch (candidate) {
    case 'L1':
      return `L1 rv-v1 composite, ${timeframe}`;
    case 'L2':
      return `L2 combined score, ${timeframe}`;
    case 'L3':
      return `L3 variance fade, ${timeframe}`;
    case 'L4':
      return `L4 positioning fade, ${timeframe}`;
    default:
      return `${candidate}, ${timeframe}`;
  }
}

function formatScore(score: number): string {
  const rounded = Math.round(score);
  if (rounded > 0) return `+${rounded}`;
  return `${rounded}`;
}

function formatParts(parts?: { v8: number | null; rvRank: number | null }): string {
  const v8Str =
    parts?.v8 !== null && parts?.v8 !== undefined
      ? `v8 ${formatScore(parts.v8)}`
      : 'v8 n/a';
  const rvStr =
    parts?.rvRank !== null && parts?.rvRank !== undefined
      ? `rv #${parts.rvRank}`
      : 'rv n/a';
  return `${v8Str}, ${rvStr}`;
}

// Rank 1 and 2 and rank 9 and 10 are the legs a rank-weighted book weights most, and color marks position in the ranking, not a buy or sell call.
function getScoreTone(rank: number, totalCoins: number): string {
  if (rank <= 2) {
    return 'text-bullish';
  }
  if (totalCoins >= 4 && rank >= totalCoins - 1) {
    return 'text-bearish';
  }
  return 'text-foreground';
}

export function formatE(e: number | null | undefined): string {
  if (e === null || e === undefined || Number.isNaN(e)) return 'n/a';
  if (e < 10) return e.toFixed(2);
  if (e < 100) return e.toFixed(1);
  return Math.round(e).toString();
}

function formatSigned3(val: number | null | undefined): string {
  if (val === null || val === undefined || Number.isNaN(val)) return 'n/a';
  const s = val.toFixed(3);
  return val > 0 && s !== '0.000' ? `+${s}` : s;
}

function format3(val: number | null | undefined): string {
  if (val === null || val === undefined || Number.isNaN(val)) return 'n/a';
  return val.toFixed(3);
}

// The meter is the board's one accent, and the log scale is how the e-process accumulates evidence, so equal widths mean equal evidence.
export function meterFillPercent(e: number, threshold: number, status: LabStatus): number {
  if (status === 'not_started' || e <= 1) {
    return 0;
  }
  const maxThreshold = threshold > 1 ? threshold : 800;
  const ratio = Math.log(e) / Math.log(maxThreshold);
  const clamped = Math.min(1, Math.max(0, ratio));
  return clamped * 100;
}

export function LabMeter({
  name,
  e,
  threshold,
  status,
}: {
  name: string;
  e: number;
  threshold: number;
  status: LabStatus;
}) {
  const fillWidth = meterFillPercent(e, threshold, status);
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={threshold}
      aria-valuenow={Number(e.toFixed(2))}
      aria-valuetext={`E ${formatE(e)} of ${threshold}`}
      aria-label={`e-value of ${name}`}
      className="mt-2.5 h-1 w-full rounded-full bg-muted overflow-hidden"
    >
      <div
        className={cn(
          'h-full',
          status === 'validated'
            ? 'bg-bullish'
            : status === 'under_test'
              ? 'bg-accent'
              : ''
        )}
        style={{ width: `${fillWidth}%` }}
      />
    </div>
  );
}

function BoardHeader({ titleId }: { titleId: string }) {
  return (
    <div className="space-y-1">
      <h2 id={titleId} className="text-base font-semibold leading-tight">
        Forward signal lab, lab-v1
      </h2>
      <p className="text-sm">
        Eight pre-registered hypotheses, each judged only on bars recorded after it started. A hypothesis is validated when its e-value reaches 800.
      </p>
      <p className="text-xs text-muted-foreground">
        Rankings describe relative order among these ten coins, not direction, and are not trade advice.
      </p>
    </div>
  );
}

function TableCell({
  symbol,
  hypothesis,
}: {
  symbol: string;
  hypothesis?: LabHypothesisView;
}) {
  if (!hypothesis?.latestBar) {
    return <td className="p-2 font-mono tabular-nums text-muted-foreground">n/a</td>;
  }

  const skipped = hypothesis.latestBar.skipped?.find((s) => s.symbol === symbol);
  if (skipped) {
    return (
      <td className="p-2 font-mono tabular-nums" title={skipped.reason}>
        <span className="text-muted-foreground">skipped</span>
        <span className="sr-only"> ({skipped.reason})</span>
      </td>
    );
  }

  const coin = hypothesis.latestBar.coins?.find((c) => c.symbol === symbol);
  if (!coin) {
    return <td className="p-2 font-mono tabular-nums text-muted-foreground">n/a</td>;
  }

  const totalCoins = hypothesis.latestBar.coins.length;
  const toneClass = getScoreTone(coin.rank, totalCoins);

  return (
    <td className="p-2 font-mono tabular-nums">
      <div>
        <span className={cn('font-medium', toneClass)}>{formatScore(coin.score)}</span>{' '}
        <span className="text-muted-foreground">#{coin.rank}</span>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {formatParts(coin.parts)}
      </div>
    </td>
  );
}

export function SignalBoard() {
  const titleId = useId();
  const combinedHeadingId = useId();
  const testStatusHeadingId = useId();
  const rankingsHeadingId = useId();

  const [mobileTimeframe, setMobileTimeframe] = useState<LabTimeframe>('1h');
  const { data, isLoading, error, refetch } = useSignalLab();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card
          data-testid="signal-lab-board"
          aria-labelledby={titleId}
          className="gap-4 py-4 sm:gap-5 sm:py-5"
        >
          <CardContent className="space-y-4 px-4 sm:space-y-5 sm:px-6">
            <BoardHeader titleId={titleId} />
            <p role="status" className="text-sm text-muted-foreground">
              Loading the lab record.
            </p>
          </CardContent>
        </Card>
        <LabV2Section />
        <LabV3Section />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <Card
          data-testid="signal-lab-board"
          aria-labelledby={titleId}
          className="gap-4 py-4 sm:gap-5 sm:py-5"
        >
          <CardContent className="space-y-4 px-4 sm:space-y-5 sm:px-6">
            <BoardHeader titleId={titleId} />
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-destructive">
                Could not load the lab record: {error.message}.
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
          </CardContent>
        </Card>
        <LabV2Section />
        <LabV3Section />
      </div>
    );
  }

  const isNothingRecorded =
    !data?.hypotheses ||
    data.hypotheses.length === 0 ||
    data.hypotheses.every((h) => h.status === 'not_started' && !h.latestBar);

  if (isNothingRecorded) {
    return (
      <div className="space-y-6">
        <Card
          data-testid="signal-lab-board"
          aria-labelledby={titleId}
          className="gap-4 py-4 sm:gap-5 sm:py-5"
        >
          <CardContent className="space-y-4 px-4 sm:space-y-5 sm:px-6">
            <BoardHeader titleId={titleId} />
            <p className="text-sm text-muted-foreground">
              No lab bar has been recorded yet. The jobs write L2 within minutes of each 5m to 1d close, and L1, L3 and L4 at 00:03, 08:03 and 16:03 UTC.
            </p>
          </CardContent>
        </Card>
        <LabV2Section />
        <LabV3Section />
      </div>
    );
  }

  const l2Hypotheses: Partial<Record<LabTimeframe, LabHypothesisView>> = {};
  for (const tf of L2_TIMEFRAMES) {
    l2Hypotheses[tf] = data.hypotheses.find(
      (h) => h.candidate === 'L2' && h.timeframe === tf
    );
  }

  const l2BarCloses = L2_TIMEFRAMES.map((tf) => l2Hypotheses[tf]?.latestBar?.barClose).filter(
    (c): c is string => typeof c === 'string'
  );
  let newestL2BarClose: string | null = null;
  if (l2BarCloses.length > 0) {
    l2BarCloses.sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
    newestL2BarClose = l2BarCloses[0];
  }

  const selectedMobileHyp = l2Hypotheses[mobileTimeframe];

  const mappedHypotheses = LAB_HYPOTHESES_V1.map((spec) =>
    data.hypotheses.find(
      (h) => h.id === spec.id || (h.candidate === spec.candidate && h.timeframe === spec.timeframe)
    )
  ).filter((h): h is LabHypothesisView => Boolean(h));
  const otherHypotheses = data.hypotheses.filter(
    (h) => !mappedHypotheses.some((m) => m.id === h.id)
  );
  const orderedHypotheses = [...mappedHypotheses, ...otherHypotheses];

  return (
    <div className="space-y-6">
      <Card
        data-testid="signal-lab-board"
        aria-labelledby={titleId}
        className="gap-4 py-4 sm:gap-5 sm:py-5"
      >
      <CardContent className="space-y-5 px-4 sm:px-6">
        <BoardHeader titleId={titleId} />

        {/* Section 1: Combined score at five timeframes */}
        <section aria-labelledby={combinedHeadingId} className="space-y-3">
          <div>
            <h3 id={combinedHeadingId} className="text-sm font-semibold">
              Combined score at five timeframes
            </h3>
            <p className="text-xs text-muted-foreground">
              0.5 x the v8 score plus 0.5 x the rv-v1 rank on a -100 to 100 scale.
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                v8: <strong className="font-semibold text-accent">Measured: no edge</strong>
              </span>
              <span>
                rv-v1: <strong className="font-semibold text-accent">Failed re-validation</strong>
              </span>
            </div>
          </div>

          {/* Desktop real table */}
          <div className="hidden sm:block overflow-x-auto">
            <table
              data-testid="signal-lab-table"
              className="w-full text-left border-collapse text-xs"
            >
              <caption className="sr-only">Combined score at five timeframes</caption>
              <thead>
                <tr className="border-b border-border">
                  <td className="p-2 font-medium text-muted-foreground">
                    <span className="sr-only">Symbol</span>
                  </td>
                  {L2_TIMEFRAMES.map((tf) => {
                    const hyp = l2Hypotheses[tf];
                    return (
                      <th key={tf} scope="col" className="p-2 font-medium">
                        <div>{tf}</div>
                        <div
                          className={cn(
                            'text-[11px] font-normal',
                            hyp?.status === 'validated'
                              ? 'text-bullish'
                              : 'text-muted-foreground'
                          )}
                        >
                          {hyp ? getStatusText(hyp) : 'Not started'}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {SIGNAL_SYMBOLS.map((symbol) => {
                  const coinName = symbol.replace('USDT', '');
                  return (
                    <tr key={symbol} className="border-b border-border/50">
                      <th scope="row" className="p-2 font-medium text-foreground whitespace-nowrap">
                        {coinName}
                      </th>
                      {L2_TIMEFRAMES.map((tf) => (
                        <TableCell
                          key={tf}
                          symbol={symbol}
                          hypothesis={l2Hypotheses[tf]}
                        />
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile single-column list */}
          <div className="sm:hidden space-y-3" data-testid="signal-lab-mobile">
            <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="L2 timeframe">
              {L2_TIMEFRAMES.map((tf) => (
                <Button
                  key={tf}
                  type="button"
                  variant={mobileTimeframe === tf ? 'default' : 'outline'}
                  aria-pressed={mobileTimeframe === tf}
                  onClick={() => setMobileTimeframe(tf)}
                  className="min-h-[44px] h-11 text-xs focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {tf}
                </Button>
              ))}
            </div>

            <p
              className={cn(
                'text-xs',
                selectedMobileHyp?.status === 'validated'
                  ? 'text-bullish'
                  : 'text-muted-foreground'
              )}
            >
              {selectedMobileHyp ? getStatusText(selectedMobileHyp) : 'Not started'}
            </p>

            <ul className="divide-y divide-border/50 rounded-md border border-border">
              {SIGNAL_SYMBOLS.map((symbol) => {
                const coinName = symbol.replace('USDT', '');
                const coin = selectedMobileHyp?.latestBar?.coins.find((c) => c.symbol === symbol);
                const skipped = selectedMobileHyp?.latestBar?.skipped?.find((s) => s.symbol === symbol);
                const totalCoins = selectedMobileHyp?.latestBar?.coins.length ?? 0;

                return (
                  <li
                    key={symbol}
                    className="flex items-center justify-between p-2.5 text-xs"
                  >
                    <span className="font-medium text-foreground">{coinName}</span>
                    {!selectedMobileHyp?.latestBar ? (
                      <span className="font-mono tabular-nums text-muted-foreground">n/a</span>
                    ) : skipped ? (
                      <span title={skipped.reason}>
                        <span className="font-mono tabular-nums text-muted-foreground">skipped</span>
                        <span className="sr-only"> ({skipped.reason})</span>
                      </span>
                    ) : coin ? (
                      <div className="text-right">
                        <div>
                          <span
                            className={cn(
                              'font-mono tabular-nums font-medium',
                              getScoreTone(coin.rank, totalCoins)
                            )}
                          >
                            {formatScore(coin.score)}
                          </span>{' '}
                          <span className="font-mono tabular-nums text-muted-foreground">
                            #{coin.rank}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono tabular-nums text-muted-foreground">
                          {formatParts(coin.parts)}
                        </div>
                      </div>
                    ) : (
                      <span className="font-mono tabular-nums text-muted-foreground">n/a</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <p className="text-xs text-muted-foreground">
            As of{' '}
            {newestL2BarClose ? (
              <span className="font-mono tabular-nums">{formatUtc(newestL2BarClose)}</span>
            ) : (
              <span className="font-mono tabular-nums">n/a</span>
            )}
          </p>
        </section>

        {/* Section 2: Test status */}
        <section aria-labelledby={testStatusHeadingId} className="space-y-3">
          <h3 id={testStatusHeadingId} className="text-sm font-semibold">
            Test status
          </h3>
          <ul className="space-y-2">
            {orderedHypotheses.map((hyp) => {
              const name = hypothesisName(hyp.candidate, hyp.timeframe);
              const thresholdVal = hyp.threshold ?? 800;

              return (
                <li
                  key={hyp.id}
                  className="rounded-md border border-border px-3 py-2.5"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs font-medium text-foreground">{name}</p>
                      <p
                        className={cn(
                          'text-xs',
                          hyp.status === 'validated'
                            ? 'text-bullish'
                            : 'text-muted-foreground'
                        )}
                      >
                        {getStatusText(hyp)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground sm:justify-end">
                      <span>E {formatE(hyp.e)} of {thresholdVal}</span>
                      <span>
                        bets {hyp.betBars !== null && hyp.betBars !== undefined ? hyp.betBars : 'n/a'}
                      </span>
                      <span>
                        mean X {formatSigned3(hyp.meanX)} vs b {format3(hyp.meanB)}
                      </span>
                      <span>
                        b now {format3(hyp.currentB)}
                      </span>
                    </div>
                  </div>
                  <LabMeter
                    name={name}
                    e={hyp.e}
                    threshold={thresholdVal}
                    status={hyp.status}
                  />
                </li>
              );
            })}
          </ul>
        </section>

        {/* Section 3: 8h rankings */}
        <section aria-labelledby={rankingsHeadingId} className="space-y-3">
          <h3 id={rankingsHeadingId} className="text-sm font-semibold">
            8h rankings
          </h3>
          <ul className="space-y-2">
            {SECTION3_HYPOTHESES.map(({ candidate, timeframe }) => {
              const hyp = data.hypotheses.find(
                (h) => h.candidate === candidate && h.timeframe === timeframe
              );
              const name = hypothesisName(candidate, timeframe);
              if (!hyp?.latestBar) {
                return (
                  <li
                    key={`${candidate}-${timeframe}`}
                    className="flex items-center justify-between rounded-md border border-border px-3 py-2.5 text-xs"
                  >
                    <span className="font-medium text-foreground">{name}</span>
                    <span className="font-mono tabular-nums text-muted-foreground">n/a</span>
                  </li>
                );
              }

              const sortedCoins = [...hyp.latestBar.coins].sort((a, b) => a.rank - b.rank);
              const coinsText = sortedCoins
                .map((c) => `${c.symbol.replace('USDT', '')} ${c.rank}`)
                .join(', ');
              const skippedText = (hyp.latestBar.skipped ?? [])
                .map((s) => `${s.symbol.replace('USDT', '')} skipped`)
                .join(', ');
              const rankings = [coinsText, skippedText].filter(Boolean).join(', ');

              return (
                <li
                  key={`${candidate}-${timeframe}`}
                  className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2.5 text-xs sm:flex-row sm:items-baseline sm:justify-between"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-medium text-foreground">{name}:</span>
                    <span className="font-mono tabular-nums text-muted-foreground">{rankings}</span>
                  </div>
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                    As of {formatUtc(hyp.latestBar.barClose)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </CardContent>
    </Card>
    <LabV2Section />
    <LabV3Section />
  </div>
  );
}
