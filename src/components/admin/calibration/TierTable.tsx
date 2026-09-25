'use client';

/**
 * The tier numbers as a table.
 *
 * Not a fallback for the chart but a peer of it: the chart answers "does any
 * interval clear zero" at a glance, the table is what you read the third
 * decimal place off, and it is the route by which any of this is reachable
 * without colour or a pointing device. It also carries the withheld-estimate
 * reason in words, which a plotted point cannot.
 */
import type { TierCalibrationRow } from '@/types/calibration';
import { TIER_COLOR, TIER_LABEL, formatCount, formatPercent } from './chart-theme';

interface TierTableProps {
  tiers: TierCalibrationRow[];
  minSamples: number;
}

function withheldLabel(row: TierCalibrationRow, minSamples: number): string {
  if (row.withheld === 'too-few-samples') return `below ${minSamples} samples`;
  if (row.withheld === 'too-few-blocks') return 'too few independent blocks';
  return '';
}

export function TierTable({ tiers, minSamples }: TierTableProps) {
  if (tiers.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-muted-foreground" data-testid="tier-table-empty">
        No resolved outcomes for this style, interval and source.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto" data-testid="tier-table">
      <table className="w-full text-sm">
        <caption className="sr-only">
          Per-tier expectancy with 95% bootstrap confidence intervals
        </caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th scope="col" className="pb-2 pr-4">Tier</th>
            <th scope="col" className="pb-2 pr-4 text-right">Signals</th>
            <th scope="col" className="pb-2 pr-4 text-right">Gross</th>
            <th scope="col" className="pb-2 pr-4 text-right">Net</th>
            <th scope="col" className="pb-2 pr-4 text-right">95% interval (net)</th>
            <th scope="col" className="pb-2 pr-4 text-right">Win rate</th>
            <th scope="col" className="pb-2 pr-4 text-right">Avg MFE</th>
            <th scope="col" className="pb-2 text-right">Avg MAE</th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((row) => {
            const clearsZero =
              row.netCiLowPercent !== null &&
              row.netCiHighPercent !== null &&
              (row.netCiLowPercent > 0 || row.netCiHighPercent < 0);
            return (
              <tr key={row.tier} className="border-b border-border/50">
                <th scope="row" className="py-1.5 pr-4 text-left text-xs font-medium">
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: TIER_COLOR[row.tier] }}
                    />
                    {TIER_LABEL[row.tier]}
                  </span>
                </th>
                <td className="py-1.5 pr-4 text-right font-mono tabular-nums">
                  {formatCount(row.count)}
                </td>
                <td className="py-1.5 pr-4 text-right font-mono tabular-nums">
                  {formatPercent(row.meanPercent)}
                </td>
                <td className="py-1.5 pr-4 text-right font-mono tabular-nums">
                  {formatPercent(row.netMeanPercent)}
                </td>
                <td className="py-1.5 pr-4 text-right font-mono text-xs tabular-nums">
                  {row.netCiLowPercent !== null && row.netCiHighPercent !== null ? (
                    <span className={clearsZero ? 'text-foreground' : 'text-muted-foreground'}>
                      {formatPercent(row.netCiLowPercent)} to {formatPercent(row.netCiHighPercent)}
                      {clearsZero ? '' : ' (spans zero)'}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {withheldLabel(row, minSamples) || '--'}
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-4 text-right font-mono tabular-nums">
                  {row.winRate === null ? '--' : `${(row.winRate * 100).toFixed(1)}%`}
                </td>
                <td className="py-1.5 pr-4 text-right font-mono tabular-nums text-muted-foreground">
                  {formatPercent(row.avgMfePercent)}
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                  {formatPercent(row.avgMaePercent)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
