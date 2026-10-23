'use client';

import React from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Cell,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import type { CalibrationMeta, TierCalibrationRow } from '@/types/calibration';
import type { SignalTier } from '@/types/signal';
import { Panel } from '@/components/kit/Panel';
import { useChartTheme } from '@/lib/chart-theme';
import { cn } from '@/lib/utils';

export interface TierPanelProps {
  data: TierCalibrationRow[];
  meta: CalibrationMeta;
  className?: string;
}

const TIER_ORDER: SignalTier[] = [
  'strong_buy',
  'buy',
  'neutral',
  'sell',
  'strong_sell',
];

const TIER_LABELS: Record<SignalTier, string> = {
  strong_buy: 'Strong buy',
  buy: 'Buy',
  neutral: 'Neutral',
  sell: 'Sell',
  strong_sell: 'Strong sell',
};

function formatSignedPercent(val: number | null | undefined): string {
  if (val === null || val === undefined || isNaN(val)) return 'n/a';
  if (Math.abs(val) < 0.0001) return '0.00%';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}

function getWithheldReason(
  withheld: TierCalibrationRow['withheld'],
  minSamples: number
): string | null {
  if (withheld === 'too-few-samples') {
    return `below ${minSamples} samples`;
  }
  if (withheld === 'too-few-blocks') {
    return 'too few independent blocks';
  }
  if (withheld !== 'none') {
    return withheld;
  }
  return null;
}

export const TierPanel: React.FC<TierPanelProps> = ({ data, meta, className }) => {
  const chartTheme = useChartTheme();

  // Sort rows in display order
  const rows = [...data].sort((a, b) => {
    const idxA = TIER_ORDER.indexOf(a.tier);
    const idxB = TIER_ORDER.indexOf(b.tier);
    return (idxA >= 0 ? idxA : 99) - (idxB >= 0 ? idxB : 99);
  });

  const chartData = rows.map((row) => ({
    tier: row.tier,
    tierLabel: TIER_LABELS[row.tier] || row.tier,
    netMeanPercent: row.withheld === 'none' ? row.netMeanPercent : null,
  }));

  const hasEstimates = rows.some(
    (row) => row.withheld === 'none' && row.netMeanPercent !== null
  );

  return (
    <Panel title="Net expectancy by tier" className={cn('space-y-6', className)}>
      {/* Horizontal bar chart */}
      {hasEstimates ? (
        <div className="h-[220px] w-full" data-testid="tier-expectancy-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              layout="vertical"
              data={chartData}
              margin={{ top: 8, right: 24, left: 16, bottom: 8 }}
            >
              <XAxis
                type="number"
                stroke={chartTheme.grid}
                tick={{ fill: chartTheme.mutedText, fontSize: 12 }}
                tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`}
              />
              <YAxis
                type="category"
                dataKey="tierLabel"
                stroke={chartTheme.grid}
                tick={{ fill: chartTheme.mutedText, fontSize: 12 }}
                width={90}
              />
              <ReferenceLine x={0} stroke={chartTheme.grid} />
              <Tooltip
                cursor={{ fill: chartTheme.volume }}
                content={({ active, payload }) => {
                  if (!active || !payload || !payload.length) return null;
                  const pt = payload[0];
                  const val = pt.value as number | null;
                  return (
                    <div className="bg-card border border-line rounded-[8px] p-2.5 text-[13px] shadow-none">
                      <p className="font-semibold text-foreground">{pt.payload.tierLabel}</p>
                      <p className="font-sans tabular-nums text-foreground mt-0.5">
                        Net expectancy: {formatSignedPercent(val)}
                      </p>
                    </div>
                  );
                }}
              />
              <Bar dataKey="netMeanPercent" radius={[0, 4, 4, 0]}>
                {chartData.map((entry) => {
                  const val = entry.netMeanPercent;
                  const fill =
                    val === null
                      ? 'transparent'
                      : val >= 0
                      ? chartTheme.up
                      : chartTheme.down;
                  return <Cell key={entry.tier} fill={fill} />;
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground font-sans">
          No tier has enough samples for an estimate yet.
        </p>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[14px]">
          <thead>
            <tr className="border-b border-line text-[12px] font-semibold text-muted-foreground">
              <th scope="col" className="py-2.5 pr-4">
                Tier
              </th>
              <th scope="col" className="py-2.5 px-4 text-right">
                Samples
              </th>
              <th scope="col" className="py-2.5 px-4 text-right">
                Net mean (95% CI)
              </th>
              <th scope="col" className="py-2.5 px-4 text-right">
                Gross mean
              </th>
              <th scope="col" className="py-2.5 pl-4 text-right">
                Win rate
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => {
              const tierLabel = TIER_LABELS[row.tier] || row.tier;
              const withheldReason = getWithheldReason(
                row.withheld,
                meta.minSamplesForEstimate
              );

              if (withheldReason) {
                return (
                  <tr key={row.tier} className="h-11">
                    <td className="py-2.5 pr-4 font-semibold text-foreground">
                      {tierLabel}
                    </td>
                    <td className="py-2.5 px-4 text-right font-sans tabular-nums text-foreground">
                      {row.count.toLocaleString()}
                    </td>
                    <td
                      colSpan={3}
                      className="py-2.5 px-4 text-right text-muted-foreground italic"
                    >
                      {withheldReason}
                    </td>
                  </tr>
                );
              }

              const isNetPositive = (row.netMeanPercent ?? 0) > 0.0001;
              const isNetNegative = (row.netMeanPercent ?? 0) < -0.0001;
              const netColor = isNetPositive
                ? 'text-up'
                : isNetNegative
                ? 'text-down'
                : 'text-foreground';

              const isGrossPositive = (row.meanPercent ?? 0) > 0.0001;
              const isGrossNegative = (row.meanPercent ?? 0) < -0.0001;
              const grossColor = isGrossPositive
                ? 'text-up'
                : isGrossNegative
                ? 'text-down'
                : 'text-foreground';

              const formattedWinRate =
                row.winRate !== null
                  ? `${(row.winRate * 100).toFixed(1)}%`
                  : 'n/a';

              return (
                <tr key={row.tier} className="h-11">
                  <td className="py-2.5 pr-4 font-semibold text-foreground">
                    {tierLabel}
                  </td>
                  <td className="py-2.5 px-4 text-right font-sans tabular-nums text-foreground">
                    {row.count.toLocaleString()}
                  </td>
                  <td className="py-2.5 px-4 text-right font-sans tabular-nums">
                    <span className={cn('font-semibold', netColor)}>
                      {formatSignedPercent(row.netMeanPercent)}
                    </span>
                    {row.netCiLowPercent !== null && row.netCiHighPercent !== null && (
                      <span className="text-[12px] text-muted-foreground ml-1.5">
                        ({formatSignedPercent(row.netCiLowPercent)} to{' '}
                        {formatSignedPercent(row.netCiHighPercent)})
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-4 text-right font-sans tabular-nums">
                    <span className={grossColor}>
                      {formatSignedPercent(row.meanPercent)}
                    </span>
                  </td>
                  <td className="py-2.5 pl-4 text-right font-sans tabular-nums text-foreground">
                    {formattedWinRate}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="text-left text-[12px] text-muted-foreground mt-3 font-sans">
          Intervals are 95% block bootstrap, with {meta.bootstrapIterations.toLocaleString()}{' '}
          iterations.
        </p>
      </div>
    </Panel>
  );
};
