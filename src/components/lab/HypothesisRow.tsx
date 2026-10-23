import React from 'react';
import { formatDistanceToNow } from 'date-fns';
import { EvidenceChip, type EvidenceKind } from '@/components/kit/EvidenceChip';
import { Tape } from '@/components/kit/Tape';
import { cn } from '@/lib/utils';

export interface HypothesisViewLike {
  id: string;
  candidate: string;
  timeframe: string;
  status: 'not_started' | 'under_test' | 'validated' | 'not_shown';
  underTestSince: string | null;
  testEndsAt: string | null;
  gradedBars: number;
  betBars: number;
  e: number;
  threshold: number;
  latestBar?: {
    barClose: string;
    [key: string]: unknown;
  } | null;
  note?: string;
}

export interface HypothesisRowProps {
  hypothesis: HypothesisViewLike;
  className?: string;
}

export const HYPOTHESIS_NAMES: Record<string, string> = {
  'L1-8h': 'Relative value ranking, 8 hours',
  'L2-5m': 'Score and ranking blend, 5 minutes',
  'L2-15m': 'Score and ranking blend, 15 minutes',
  'L2-1h': 'Score and ranking blend, 1 hour',
  'L2-4h': 'Score and ranking blend, 4 hours',
  'L2-1d': 'Score and ranking blend, daily',
  'L3-8h': 'Volatility fade, 8 hours',
  'L4-8h': 'Positioning fade, 8 hours',
  'N2-1w': 'Weekly trend, weekly',
  'N3-1d': 'Value area drift, daily',
  'F1-1d': 'Funding carry, daily',
  'S1-1h': 'Swing break with taker flow, hourly',
  'S2-1h': 'Taker flow divergence, faded, hourly',
};

export function getHypothesisDisplayName(candidate: string, timeframe: string, id?: string): string {
  const key = id || `${candidate}-${timeframe}`;
  return HYPOTHESIS_NAMES[key] || `${candidate} ${timeframe}`;
}

export function getChipConfig(status: HypothesisViewLike['status']): { kind: EvidenceKind; label: string } {
  switch (status) {
    case 'under_test':
      return { kind: 'under-test', label: 'Under test' };
    case 'validated':
      return { kind: 'validated', label: 'Validated' };
    case 'not_started':
      return { kind: 'not-started', label: 'Not started' };
    case 'not_shown':
      return { kind: 'context', label: 'Not shown' };
  }
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Not yet';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toISOString().split('T')[0];
  } catch {
    return String(iso);
  }
}

function formatBarTime(iso: string | null | undefined): string {
  if (!iso) return 'Not yet';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch {
    return String(iso);
  }
}

function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return formatDistanceToNow(d, { addSuffix: true });
  } catch {
    return '';
  }
}

export const HypothesisRow: React.FC<HypothesisRowProps> = ({
  hypothesis,
  className,
}) => {
  const displayName = getHypothesisDisplayName(hypothesis.candidate, hypothesis.timeframe, hypothesis.id);
  const chipConfig = getChipConfig(hypothesis.status);
  const isNotShown = hypothesis.status === 'not_shown';

  const relativeTime = hypothesis.latestBar?.barClose
    ? formatRelativeTime(hypothesis.latestBar.barClose)
    : '';

  return (
    <article
      data-testid="hypothesis-row"
      data-hypothesis-id={hypothesis.id}
      className={cn('py-3.5 border-t border-line first:border-t-0', className)}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-2">
          <h3 className="font-semibold text-foreground text-[15px]">{displayName}</h3>
          <span className="text-[13px] text-muted-foreground font-sans tabular-nums">{hypothesis.id}</span>
        </div>
        <EvidenceChip kind={chipConfig.kind} label={chipConfig.label} />
      </div>

      <Tape
        betCount={hypothesis.betBars}
        evidence={hypothesis.e}
        threshold={hypothesis.threshold}
        className="my-2"
      />

      {isNotShown ? (
        <p className="text-[14px] text-muted-foreground mt-1">
          Its 24 months ended without reaching the bar. It keeps no claim.
        </p>
      ) : (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[14px] text-muted-foreground mt-1">
          <span className="font-sans tabular-nums">
            {hypothesis.betBars} bets. Evidence {hypothesis.e.toFixed(1)} of {hypothesis.threshold} needed.
          </span>
          {relativeTime && (
            <span className="text-[13px] text-muted-foreground">Updated {relativeTime}</span>
          )}
        </div>
      )}

      {hypothesis.note && (
        <p className="text-[13px] text-muted-foreground mt-1">{hypothesis.note}</p>
      )}

      <details className="mt-2 text-[13px] text-muted-foreground">
        <summary className="cursor-pointer font-medium hover:text-foreground inline-flex items-center min-h-[44px] py-1 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          Record details
        </summary>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 pb-1 border-t border-line mt-1">
          <div>
            <span className="block text-[12px] text-muted-foreground">Under test since</span>
            <span className="font-semibold text-foreground font-sans tabular-nums">
              {formatDate(hypothesis.underTestSince)}
            </span>
          </div>
          <div>
            <span className="block text-[12px] text-muted-foreground">Test ends</span>
            <span className="font-semibold text-foreground font-sans tabular-nums">
              {formatDate(hypothesis.testEndsAt)}
            </span>
          </div>
          <div>
            <span className="block text-[12px] text-muted-foreground">Graded bars</span>
            <span className="font-semibold text-foreground font-sans tabular-nums">
              {hypothesis.gradedBars.toLocaleString()}
            </span>
          </div>
          <div>
            <span className="block text-[12px] text-muted-foreground">Latest bar</span>
            <span className="font-semibold text-foreground font-sans tabular-nums">
              {formatBarTime(hypothesis.latestBar?.barClose)}
            </span>
          </div>
        </div>
      </details>
    </article>
  );
};
