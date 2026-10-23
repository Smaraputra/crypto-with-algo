import React from 'react';
import type { CalibrationMeta } from '@/types/calibration';
import { cn } from '@/lib/utils';

export interface CoverageLineProps {
  meta: CalibrationMeta;
  className?: string;
}

function formatDate(ts: number | null): string {
  if (ts === null || ts === undefined || isNaN(ts)) return 'n/a';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatSpan(from: number | null, to: number | null): string {
  if (from === null && to === null) return 'n/a';
  if (from === null) return `n/a to ${formatDate(to)}`;
  if (to === null) return `${formatDate(from)} to n/a`;
  return `${formatDate(from)} to ${formatDate(to)}`;
}

export const CoverageLine: React.FC<CoverageLineProps> = ({ meta, className }) => {
  const { statusCounts, horizonBars, costPercentRoundTrip, costIsDefault, minSamplesForEstimate } = meta;

  return (
    <dl
      data-testid="coverage-header"
      className={cn(
        'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 p-4 bg-card rounded-[14px] border border-line text-[13px]',
        className
      )}
    >
      <div className="flex flex-col gap-1">
        <dt className="text-[12px] font-semibold text-muted-foreground">Outcomes</dt>
        <dd className="font-sans tabular-nums font-semibold text-foreground">
          {statusCounts.resolved.toLocaleString()} resolved, {statusCounts.pending.toLocaleString()} pending,{' '}
          {statusCounts.unresolvable.toLocaleString()} unresolvable
        </dd>
      </div>

      <div className="flex flex-col gap-1">
        <dt className="text-[12px] font-semibold text-muted-foreground">Resolved span</dt>
        <dd className="font-sans tabular-nums font-semibold text-foreground">
          {formatSpan(meta.resolvedFrom, meta.resolvedTo)}
        </dd>
      </div>

      <div className="flex flex-col gap-1">
        <dt className="text-[12px] font-semibold text-muted-foreground">Horizon</dt>
        <dd className="font-sans tabular-nums font-semibold text-foreground">{horizonBars} bars</dd>
      </div>

      <div className="flex flex-col gap-1">
        <dt className="text-[12px] font-semibold text-muted-foreground">Round-trip cost</dt>
        <dd className="font-sans tabular-nums font-semibold text-foreground">
          {costPercentRoundTrip.toFixed(2)}%{costIsDefault ? ' (default)' : ''}
        </dd>
      </div>

      <div className="flex flex-col gap-1">
        <dt className="text-[12px] font-semibold text-muted-foreground">Min samples</dt>
        <dd className="font-sans tabular-nums font-semibold text-foreground">{minSamplesForEstimate}</dd>
      </div>
    </dl>
  );
};
