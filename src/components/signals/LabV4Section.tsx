'use client';

import { useId } from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSignalLabV4 } from '@/hooks/useSignalLabV4';
import { LAB_HYPOTHESES_V4 } from '@/lib/signals/lab/candidates';
import type { LabV4HypothesisView } from '@/lib/signals/lab/view';
import {
  formatE,
  formatUtc,
  getStatusText,
  LabMeter,
} from '@/components/signals/SignalBoard';

export function labV4HypothesisName(candidate: string): string {
  switch (candidate) {
    case 'S1':
      return 'S1 swing CHoCH flow confirm';
    case 'S2':
      return 'S2 delta divergence fade';
    default:
      return candidate;
  }
}

export function formatPercent3(val: number | null | undefined): string {
  if (val === null || val === undefined || Number.isNaN(val)) return 'n/a';
  const pct = val * 100;
  const s = pct.toFixed(3);
  return pct > 0 && s !== '0.000' ? `+${s}%` : `${s}%`;
}

function LabV4Header({ titleId }: { titleId: string }) {
  return (
    <div className="space-y-1">
      <h2 id={titleId} className="text-base font-semibold leading-tight">
        Forward lab, lab-v4 (Round 3 structure and flow)
      </h2>
      <p className="text-sm">
        Two rules on 1h perp bars, each trade held 8 hours: S1 trades a swing change of character confirmed by that bar&apos;s taker delta, S2 fades a taker-delta divergence at swing pivots. Both lost money on history after costs, so they are recorded forward by the owner&apos;s choice, not because they look promising.
      </p>
    </div>
  );
}

function renderOpenTrades(hyp: LabV4HypothesisView) {
  if (!hyp.openTrades || hyp.openTrades.length === 0) {
    return (
      <span className="inline-flex items-center rounded border border-border bg-muted/40 px-2 py-0.5 text-xs font-mono text-muted-foreground">
        No open trades
      </span>
    );
  }

  return hyp.openTrades.map((trade) => {
    const coin = trade.symbol.replace('USDT', '');
    const side = trade.side === 1 ? 'Long' : 'Short';
    let timeStr = 'n/a';
    try {
      timeStr = `${new Date(trade.exitsAt).toISOString().slice(11, 16)} UTC`;
    } catch {
      timeStr = 'n/a';
    }
    const label = `${coin} ${side}, exits at ${timeStr}`;
    return (
      <span
        key={`${trade.symbol}-${trade.enteredAt}`}
        className="inline-flex items-center rounded border border-border bg-muted/40 px-2 py-0.5 text-xs font-mono tabular-nums text-foreground"
      >
        {label}
      </span>
    );
  });
}

export function LabV4Section() {
  const titleId = useId();
  const { data, isLoading, error, refetch } = useSignalLabV4();

  if (isLoading) {
    return (
      <Card
        data-testid="signal-lab-v4-section"
        aria-labelledby={titleId}
        className="gap-4 py-4 sm:gap-5 sm:py-5"
      >
        <CardContent className="space-y-4 px-4 sm:space-y-5 sm:px-6">
          <LabV4Header titleId={titleId} />
          <p role="status" className="text-sm text-muted-foreground">
            Loading the lab record.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card
        data-testid="signal-lab-v4-section"
        aria-labelledby={titleId}
        className="gap-4 py-4 sm:gap-5 sm:py-5"
      >
        <CardContent className="space-y-4 px-4 sm:space-y-5 sm:px-6">
          <LabV4Header titleId={titleId} />
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
    );
  }

  const isNothingRecorded =
    !data?.hypotheses ||
    data.hypotheses.length === 0 ||
    data.hypotheses.every((h) => h.status === 'not_started' && !h.latestBar);

  if (isNothingRecorded) {
    return (
      <Card
        data-testid="signal-lab-v4-section"
        aria-labelledby={titleId}
        className="gap-4 py-4 sm:gap-5 sm:py-5"
      >
        <CardContent className="space-y-4 px-4 sm:space-y-5 sm:px-6">
          <LabV4Header titleId={titleId} />
          <p className="text-sm text-muted-foreground">
            No lab bar has been recorded yet. The job writes S1 and S2 hourly after bar close.
          </p>
        </CardContent>
      </Card>
    );
  }

  const orderedHypotheses = LAB_HYPOTHESES_V4.map((spec) =>
    data.hypotheses.find(
      (h) => h.id === spec.id || (h.candidate === spec.candidate && h.timeframe === spec.timeframe)
    )
  ).filter((h): h is LabV4HypothesisView => Boolean(h));

  const otherHypotheses = data.hypotheses.filter(
    (h) => !orderedHypotheses.some((m) => m.id === h.id)
  );
  const hypotheses = [...orderedHypotheses, ...otherHypotheses];

  return (
    <Card
      data-testid="signal-lab-v4-section"
      aria-labelledby={titleId}
      className="gap-4 py-4 sm:gap-5 sm:py-5"
    >
      <CardContent className="space-y-5 px-4 sm:px-6">
        <LabV4Header titleId={titleId} />

        <ul className="space-y-2">
          {hypotheses.map((hyp) => {
            const name = labV4HypothesisName(hyp.candidate);

            return (
              <li
                key={hyp.id}
                className="rounded-md border border-border px-3 py-2.5"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs font-medium text-foreground">{name}</p>
                    {hyp.absorbed ? (
                      <p className="text-xs text-bearish">
                        Stopped: a loss beyond the test&apos;s bound ended this test
                      </p>
                    ) : (
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
                    )}
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground sm:justify-end">
                    <span>E {formatE(hyp.e)} of {hyp.threshold}</span>
                    <span>
                      bets {hyp.betBars !== null && hyp.betBars !== undefined ? hyp.betBars : 'n/a'}
                    </span>
                    <span>
                      mean net return {formatPercent3(hyp.meanNetReturn)}
                    </span>
                  </div>
                </div>

                <LabMeter
                  name={name}
                  e={hyp.e}
                  threshold={hyp.threshold}
                  status={hyp.status}
                />

                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-muted-foreground">Open trades:</span>
                    {renderOpenTrades(hyp)}
                  </div>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {hyp.latestBar ? `As of ${formatUtc(hyp.latestBar.barClose)}` : 'As of n/a'}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
