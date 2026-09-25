'use client';

/**
 * Forward-return distribution per tier, with the cost band drawn over it.
 *
 * The mean is the number everyone reads; this is the chart that puts it in
 * proportion. The shaded band spans plus and minus the round-trip cost
 * estimate, so the share of outcomes that never had a chance of paying for
 * themselves is visible directly rather than inferred from a summary statistic.
 *
 * Bin edges are shared across tiers and the panels stack vertically on one
 * x-scale: small multiples with independent scales would rescale each tier into
 * looking like the others, which is the opposite of what the view is for.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { DistributionResponse } from '@/types/calibration';
import type { SignalTier } from '@/types/signal';
import {
  AXIS_TICK,
  GRID_COLOR,
  TIER_COLOR,
  TIER_LABEL,
  TOOLTIP_STYLE,
  ZERO_LINE_COLOR,
  formatCount,
} from './chart-theme';

interface ReturnDistributionChartProps {
  distribution: DistributionResponse;
  costPercent: number;
  /** Tiers to draw, in the order given. Defaults to every tier present. */
  tiers?: SignalTier[];
}

export function ReturnDistributionChart({
  distribution,
  costPercent,
  tiers,
}: ReturnDistributionChartProps) {
  const shown = tiers ?? distribution.tiers;

  if (distribution.bins.length === 0 || shown.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground" data-testid="distribution-empty">
        No resolved outcomes to plot.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="return-distribution-chart">
      {shown.map((tier) => {
        const data = distribution.bins.map((bin) => ({
          mid: (bin.low + bin.high) / 2,
          count: bin.counts[tier] ?? 0,
        }));
        const total = data.reduce((sum, row) => sum + row.count, 0);
        const clipped = distribution.clipped[tier] ?? 0;

        return (
          <div key={tier} data-testid={`distribution-${tier}`}>
            <div className="flex items-baseline justify-between px-1">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: TIER_COLOR[tier] }}
                />
                {TIER_LABEL[tier]}
              </span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                n={formatCount(total)}
                {clipped > 0 ? ` (+${formatCount(clipped)} off-scale)` : ''}
              </span>
            </div>
            <ResponsiveContainer width="100%" height={110}>
              <BarChart data={data} margin={{ top: 4, right: 12, bottom: 4, left: 8 }}>
                <CartesianGrid stroke={GRID_COLOR} strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="mid"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tick={AXIS_TICK}
                  stroke={GRID_COLOR}
                  tickFormatter={(value: number) => `${value.toFixed(1)}%`}
                />
                <YAxis tick={AXIS_TICK} stroke={GRID_COLOR} width={44} allowDecimals={false} />
                {/* Drawn before the bars so the band sits behind the data. */}
                <ReferenceArea
                  x1={-costPercent}
                  x2={costPercent}
                  fill="var(--color-muted-foreground)"
                  fillOpacity={0.12}
                />
                <ReferenceLine x={0} stroke={ZERO_LINE_COLOR} strokeWidth={2} />
                <Tooltip
                  cursor={{ fill: 'var(--color-card-hover)' }}
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(value) => [formatCount(Number(value)), 'signals']}
                  labelFormatter={(label) => `${Number(label).toFixed(2)}% forward return`}
                />
                <Bar dataKey="count" fill={TIER_COLOR[tier]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        );
      })}
      <p className="text-center text-xs text-muted-foreground">
        Signed forward return, before cost, shared bins across tiers. The shaded band is plus and
        minus the {costPercent.toFixed(2)}% round-trip cost: outcomes inside it could not have paid
        for the trade in either direction.
      </p>
    </div>
  );
}
