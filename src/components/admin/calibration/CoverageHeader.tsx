'use client';

/**
 * What the record actually covers, above the charts rather than beneath them.
 *
 * On a record that only begins at the 2026-09-17 finalization deploy, the most
 * common wrong reading of every chart below is treating "no edge visible" as a
 * measurement when it is really "barely any data yet". These tiles exist to make
 * that distinction unavoidable: resolved count, the window it spans, how many
 * are still pending, and which scorers are mixed into the view.
 *
 * Stat tiles rather than a chart, because five unrelated scalars have no shared
 * scale and plotting them would imply one.
 */
import type { CalibrationMeta } from '@/types/calibration';
import { formatCount } from './chart-theme';

interface CoverageHeaderProps {
  meta: CalibrationMeta;
}

function formatDay(timestamp: number | null): string {
  if (timestamp === null) return '--';
  return new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-mono text-sm tabular-nums text-foreground">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function CoverageHeader({ meta }: CoverageHeaderProps) {
  const pooledVersions = meta.configVersion === null && meta.configVersions.length > 1;

  return (
    <div className="space-y-2" data-testid="coverage-header">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Tile
          label="Resolved outcomes"
          value={formatCount(meta.statusCounts.resolved)}
          hint={`${formatCount(meta.statusCounts.pending)} pending`}
        />
        <Tile
          label="In this view"
          value={formatCount(meta.rowCount)}
          hint={meta.configVersion === null ? 'all versions' : `configVersion ${meta.configVersion}`}
        />
        <Tile label="Covers" value={formatDay(meta.resolvedFrom)} hint={`to ${formatDay(meta.resolvedTo)}`} />
        <Tile
          label="Horizon"
          value={`${meta.horizonBars} bars`}
          hint={`at ${meta.interval}, block length ${meta.meanBlockLenBars}`}
        />
        <Tile
          label="Round-trip cost"
          value={`${meta.costPercentRoundTrip.toFixed(2)}%`}
          hint={meta.costIsDefault ? 'taker estimate, both legs' : 'override'}
        />
      </div>

      {pooledVersions ? (
        <p
          className="rounded-md border border-bearish/40 bg-bearish-muted/40 px-3 py-2 text-xs text-foreground"
          data-testid="pooled-versions-warning"
        >
          This view pools configVersions {meta.configVersions.join(', ')}. Each version is a
          different scorer, so a pooled mean measures none of them. Pick a version to read a number
          you can act on.
        </p>
      ) : null}

      {/* rowCount, not statusCounts.resolved: coverage is deliberately
          unfiltered, so a 5-row symbol slice of a 5,000-row record would
          withhold every estimate while this note stayed hidden. */}
      {meta.rowCount < meta.minSamplesForEstimate ? (
        <p className="text-xs text-muted-foreground" data-testid="thin-record-note">
          The record is thin. Estimates are withheld below {meta.minSamplesForEstimate} observations
          and intervals below {meta.minBlocksForCi} independent blocks.
        </p>
      ) : null}
    </div>
  );
}
