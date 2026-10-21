'use client';

import { useId } from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSignalLabV2 } from '@/hooks/useSignalLabV2';
import { LAB_HYPOTHESES_V2 } from '@/lib/signals/lab/candidates';
import type { LabV2HypothesisView } from '@/lib/signals/lab/view';
import {
  formatE,
  formatUtc,
  getStatusText,
  LabMeter,
} from '@/components/signals/SignalBoard';

export function labV2HypothesisName(candidate: string): string {
  switch (candidate) {
    case 'N2':
      return 'N2 weekly ridge';
    case 'N3':
      return 'N3 value-area drift';
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

function LabV2Header({ titleId }: { titleId: string }) {
  return (
    <div className="space-y-1">
      <h2 id={titleId} className="text-base font-semibold leading-tight">
        Forward lab, lab-v2 (Round 1 survivors)
      </h2>
      <p className="text-sm">
        Two rules that passed a historical screen once, judged on live bars by their net return after costs and funding. Neither is expected to reach its threshold: history shows effects about ten times too small to verify within 24 months.
      </p>
    </div>
  );
}

function renderPositions(hyp: LabV2HypothesisView) {
  if (!hyp.latestBar || hyp.latestBar.cash || hyp.latestBar.positions.length === 0) {
    return (
      <span className="inline-flex items-center rounded border border-border bg-muted/40 px-2 py-0.5 text-xs font-mono text-muted-foreground">
        Cash
      </span>
    );
  }

  return hyp.latestBar.positions.map((pos) => {
    const coin = pos.symbol.replace('USDT', '');
    let label = '';
    if (hyp.candidate === 'N3') {
      const side = pos.weight > 0 ? 'long' : pos.weight < 0 ? 'short' : 'flat';
      label = `${coin} ${side}`;
    } else {
      const formattedWeight = pos.weight > 0 ? `+${pos.weight.toFixed(2)}` : pos.weight.toFixed(2);
      label = `${coin} ${formattedWeight}`;
    }
    return (
      <span
        key={pos.symbol}
        className="inline-flex items-center rounded border border-border bg-muted/40 px-2 py-0.5 text-xs font-mono tabular-nums text-foreground"
      >
        {label}
      </span>
    );
  });
}

export function LabV2Section() {
  const titleId = useId();
  const { data, isLoading, error, refetch } = useSignalLabV2();

  if (isLoading) {
    return (
      <Card
        data-testid="signal-lab-v2-section"
        aria-labelledby={titleId}
        className="gap-4 py-4 sm:gap-5 sm:py-5"
      >
        <CardContent className="space-y-4 px-4 sm:space-y-5 sm:px-6">
          <LabV2Header titleId={titleId} />
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
        data-testid="signal-lab-v2-section"
        aria-labelledby={titleId}
        className="gap-4 py-4 sm:gap-5 sm:py-5"
      >
        <CardContent className="space-y-4 px-4 sm:space-y-5 sm:px-6">
          <LabV2Header titleId={titleId} />
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
        data-testid="signal-lab-v2-section"
        aria-labelledby={titleId}
        className="gap-4 py-4 sm:gap-5 sm:py-5"
      >
        <CardContent className="space-y-4 px-4 sm:space-y-5 sm:px-6">
          <LabV2Header titleId={titleId} />
          <p className="text-sm text-muted-foreground">
            No lab bar has been recorded yet. The jobs write N3 at 00:03 UTC daily, and N2 at 00:03 UTC on Mondays.
          </p>
        </CardContent>
      </Card>
    );
  }

  const orderedHypotheses = LAB_HYPOTHESES_V2.map((spec) =>
    data.hypotheses.find(
      (h) => h.id === spec.id || (h.candidate === spec.candidate && h.timeframe === spec.timeframe)
    )
  ).filter((h): h is LabV2HypothesisView => Boolean(h));

  const otherHypotheses = data.hypotheses.filter(
    (h) => !orderedHypotheses.some((m) => m.id === h.id)
  );
  const hypotheses = [...orderedHypotheses, ...otherHypotheses];

  return (
    <Card
      data-testid="signal-lab-v2-section"
      aria-labelledby={titleId}
      className="gap-4 py-4 sm:gap-5 sm:py-5"
    >
      <CardContent className="space-y-5 px-4 sm:px-6">
        <LabV2Header titleId={titleId} />

        <ul className="space-y-2">
          {hypotheses.map((hyp) => {
            const name = labV2HypothesisName(hyp.candidate);

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
                    <span className="text-muted-foreground">Positions:</span>
                    {renderPositions(hyp)}
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
