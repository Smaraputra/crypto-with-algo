'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useSignalLab } from '@/hooks/useSignalLab';
import { useSignalLabV2 } from '@/hooks/useSignalLabV2';
import { useSignalLabV3 } from '@/hooks/useSignalLabV3';
import { formatE } from '@/components/signals/SignalBoard';
import type { LabStatus } from '@/lib/signals/lab/view';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { LAB_V3_UNIVERSE } from '@/lib/signals/lab/candidates';
import { cn } from '@/lib/utils';
import { EvidenceTag, labStatusKind } from './EvidenceTag';
import { formatAge } from './format';

export interface BestWeHaveProps {
  symbol: string;
  className?: string;
}

interface BestWeHaveRowItem {
  id: string;
  e: number;
  threshold: number;
  status: LabStatus;
  barClose: string | null;
  opinion: string;
}

export function BestWeHave({ symbol, className }: BestWeHaveProps) {
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);
  const labV3 = useSignalLabV3();
  const labV2 = useSignalLabV2();
  const labV1 = useSignalLab();

  const inSignalSymbols = (SIGNAL_SYMBOLS as readonly string[]).includes(symbol);
  const inLabV3Universe = (LAB_V3_UNIVERSE as readonly string[]).includes(symbol);

  const rows: BestWeHaveRowItem[] = [];

  // Lab-v3 (F1)
  if (labV3.data?.hypotheses) {
    for (const hyp of labV3.data.hypotheses) {
      let opinion: string;
      if (!inLabV3Universe) {
        opinion = "Not in this lab's coins";
      } else if (!hyp.latestBar) {
        opinion = 'No bar yet';
      } else if (hyp.latestBar.cash) {
        opinion = 'Cash';
      } else if (hyp.latestBar.positions) {
        const pos = hyp.latestBar.positions.find((p) => p.symbol === symbol);
        if (pos && Math.abs(pos.weight) >= 0.0005) {
          opinion =
            pos.weight > 0
              ? `Long ${pos.weight.toFixed(3)}`
              : `Short ${Math.abs(pos.weight).toFixed(3)}`;
        } else {
          opinion = 'No position';
        }
      } else {
        opinion = 'No position';
      }
      rows.push({
        id: hyp.id,
        e: hyp.e,
        threshold: hyp.threshold,
        status: hyp.status,
        barClose: hyp.latestBar?.barClose ?? null,
        opinion,
      });
    }
  }

  // Lab-v2 (N2, N3)
  if (labV2.data?.hypotheses) {
    for (const hyp of labV2.data.hypotheses) {
      let opinion: string;
      if (!inSignalSymbols) {
        opinion = "Not in this lab's coins";
      } else if (!hyp.latestBar) {
        opinion = 'No bar yet';
      } else if (hyp.latestBar.cash) {
        opinion = 'Cash';
      } else if (hyp.latestBar.positions) {
        const pos = hyp.latestBar.positions.find((p) => p.symbol === symbol);
        if (pos && Math.abs(pos.weight) >= 0.0005) {
          opinion =
            pos.weight > 0
              ? `Long ${pos.weight.toFixed(3)}`
              : `Short ${Math.abs(pos.weight).toFixed(3)}`;
        } else {
          opinion = 'No position';
        }
      } else {
        opinion = 'No position';
      }
      rows.push({
        id: hyp.id,
        e: hyp.e,
        threshold: hyp.threshold,
        status: hyp.status,
        barClose: hyp.latestBar?.barClose ?? null,
        opinion,
      });
    }
  }

  // Lab-v1
  let notInLab1 = false;
  if (labV1.data?.hypotheses && labV1.data.hypotheses.length > 0) {
    if (!inSignalSymbols) {
      notInLab1 = true;
    } else {
      for (const hyp of labV1.data.hypotheses) {
        const coin = hyp.latestBar?.coins?.find((c) => c.symbol === symbol);
        if (coin && hyp.latestBar) {
          const totalCoins = hyp.latestBar.coins.length;
          const opinion = `Rank ${coin.rank} of ${totalCoins}, not a direction`;
          rows.push({
            id: hyp.id,
            e: hyp.e,
            threshold: hyp.threshold,
            status: hyp.status,
            barClose: hyp.latestBar.barClose ?? null,
            opinion,
          });
        } else {
          rows.push({
            id: hyp.id,
            e: hyp.e,
            threshold: hyp.threshold,
            status: hyp.status,
            barClose: null,
            opinion: 'No bar yet',
          });
        }
      }
    }
  }

  // Sort rows by e / threshold, descending
  rows.sort((a, b) => {
    const ratioA = a.threshold > 0 ? a.e / a.threshold : 0;
    const ratioB = b.threshold > 0 ? b.e / b.threshold : 0;
    return ratioB - ratioA;
  });

  const visibleRows = expanded ? rows : rows.slice(0, 4);

  const allQueriesLoaded =
    !labV3.isLoading && !labV2.isLoading && !labV1.isLoading;
  const noDataAtAll =
    allQueriesLoaded &&
    !labV3.error &&
    !labV2.error &&
    !labV1.error &&
    rows.length === 0 &&
    !notInLab1;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="best-we-have"
      className={cn('space-y-3 p-4', className)}
    >
      <h3 id={headingId} className="text-sm font-semibold">Best we have on this coin</h3>

      {/* Individual query loading/error status lines */}
      {labV3.isLoading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading lab-v3...
        </p>
      )}
      {labV3.error && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-destructive">
            Could not load lab-v3: {labV3.error.message}.
          </p>
          <Button
            variant="outline"
            size="xs"
            className="min-h-11 sm:min-h-6"
            onClick={() => void labV3.refetch()}
          >
            Retry
          </Button>
        </div>
      )}

      {labV2.isLoading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading lab-v2...
        </p>
      )}
      {labV2.error && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-destructive">
            Could not load lab-v2: {labV2.error.message}.
          </p>
          <Button
            variant="outline"
            size="xs"
            className="min-h-11 sm:min-h-6"
            onClick={() => void labV2.refetch()}
          >
            Retry
          </Button>
        </div>
      )}

      {labV1.isLoading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading lab-v1...
        </p>
      )}
      {labV1.error && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-destructive">
            Could not load lab-v1: {labV1.error.message}.
          </p>
          <Button
            variant="outline"
            size="xs"
            className="min-h-11 sm:min-h-6"
            onClick={() => void labV1.refetch()}
          >
            Retry
          </Button>
        </div>
      )}

      {noDataAtAll && (
        <p className="text-sm text-muted-foreground">
          No lab hypotheses recorded yet.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="space-y-2 text-xs">
          {visibleRows.map((row) => (
            <li
              key={row.id}
              data-testid={`best-row-${row.id}`}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5 border-b border-border/50 last:border-b-0"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{row.id}</span>
                <EvidenceTag kind={labStatusKind(row.status)} />
                <span className="font-mono tabular-nums">{row.opinion}</span>
              </div>
              <div className="flex items-center gap-2.5 font-mono tabular-nums text-muted-foreground">
                <span>
                  E {formatE(row.e)} of {row.threshold}
                </span>
                <span>
                  {row.barClose
                    ? `as of ${formatAge(row.barClose)}`
                    : 'as of n/a'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {rows.length > 4 && (
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-0 text-xs"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? 'Show fewer' : `Show all ${rows.length}`}
        </Button>
      )}

      {notInLab1 && (
        <p className="text-xs text-muted-foreground">
          Not in lab-v1&apos;s 10 coins
        </p>
      )}
    </section>
  );
}
