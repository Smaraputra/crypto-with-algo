'use client';

/**
 * Net expectancy per tier with its bootstrap interval.
 *
 * A dot-and-interval plot rather than bars. Bars encode magnitude from a zero
 * baseline and invite reading the bar as the quantity; here the quantity that
 * matters is whether the INTERVAL clears zero, and a bar drawn to a point
 * estimate makes a result look solid in exactly the case where it is not.
 *
 * The zero line is the reference the whole chart exists to compare against, so
 * it is drawn more strongly than the grid.
 */
import {
  CartesianGrid,
  ErrorBar,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { TierCalibrationRow } from '@/types/calibration';
import {
  AXIS_TICK,
  GRID_COLOR,
  TIER_COLOR,
  TIER_LABEL,
  TOOLTIP_STYLE,
  ZERO_LINE_COLOR,
  formatCount,
  formatPercent,
} from './chart-theme';

interface TierExpectancyChartProps {
  tiers: TierCalibrationRow[];
  costPercent: number;
}

interface PlotPoint {
  tierIndex: number;
  tier: string;
  label: string;
  net: number;
  /** Recharts ErrorBar takes [below, above] as distances, not absolute bounds. */
  error: [number, number];
  count: number;
  hasCi: boolean;
}

const TIER_ORDER = ['strong_sell', 'sell', 'neutral', 'buy', 'strong_buy'] as const;

export function TierExpectancyChart({ tiers, costPercent }: TierExpectancyChartProps) {
  const points: PlotPoint[] = tiers
    .filter((row) => row.netMeanPercent !== null)
    .map((row) => {
      const net = row.netMeanPercent as number;
      const hasCi = row.netCiLowPercent !== null && row.netCiHighPercent !== null;
      return {
        tierIndex: TIER_ORDER.indexOf(row.tier as (typeof TIER_ORDER)[number]),
        tier: row.tier,
        label: TIER_LABEL[row.tier],
        net,
        error: hasCi
          ? [net - (row.netCiLowPercent as number), (row.netCiHighPercent as number) - net]
          : [0, 0],
        count: row.count,
        hasCi,
      };
    });

  if (points.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground" data-testid="tier-expectancy-empty">
        No tier has enough resolved outcomes to estimate an expectancy yet.
      </p>
    );
  }

  return (
    <div data-testid="tier-expectancy-chart">
      <ResponsiveContainer width="100%" height={260}>
        <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 12 }}>
          <CartesianGrid stroke={GRID_COLOR} strokeDasharray="2 4" />
          <XAxis
            type="number"
            dataKey="tierIndex"
            domain={[-0.5, 4.5]}
            ticks={[0, 1, 2, 3, 4]}
            tickFormatter={(value: number) => TIER_LABEL[TIER_ORDER[value]] ?? ''}
            tick={AXIS_TICK}
            stroke={GRID_COLOR}
          />
          <YAxis
            type="number"
            dataKey="net"
            tick={AXIS_TICK}
            stroke={GRID_COLOR}
            tickFormatter={(value: number) => `${value.toFixed(2)}%`}
            width={72}
            label={{
              value: 'Net expectancy %',
              angle: -90,
              position: 'insideLeft',
              style: { fill: 'var(--color-muted-foreground)', fontSize: 11, textAnchor: 'middle' },
            }}
          />
          <ReferenceLine y={0} stroke={ZERO_LINE_COLOR} strokeWidth={2} />
          <Tooltip
            cursor={{ stroke: GRID_COLOR }}
            contentStyle={TOOLTIP_STYLE}
            formatter={(_value, _name, item) => {
              const point = item?.payload as PlotPoint | undefined;
              if (!point) return null;
              const ci = point.hasCi
                ? `${formatPercent(point.net - point.error[0])} to ${formatPercent(point.net + point.error[1])}`
                : 'interval withheld';
              return [`${formatPercent(point.net)} (${ci}), n=${formatCount(point.count)}`, point.label];
            }}
            labelFormatter={() => ''}
          />
          {/* One Scatter per tier rather than one series with per-point Cells:
              Recharts drops the ErrorBar children when Cell children are
              present on the same Scatter, which silently removed the whiskers
              -- the one mark this chart exists to show. */}
          {points.map((point) => (
            <Scatter
              key={point.tier}
              name={point.label}
              data={[point]}
              fill={
                point.hasCi ? TIER_COLOR[point.tier as keyof typeof TIER_COLOR] : 'transparent'
              }
              stroke={TIER_COLOR[point.tier as keyof typeof TIER_COLOR]}
              strokeWidth={2}
              shape="circle"
              isAnimationActive={false}
            >
              {point.hasCi ? (
                <ErrorBar
                  dataKey="error"
                  direction="y"
                  width={6}
                  strokeWidth={2}
                  stroke="var(--color-muted-foreground)"
                />
              ) : null}
            </Scatter>
          ))}
        </ScatterChart>
      </ResponsiveContainer>
      <p className="mt-1 text-center text-xs text-muted-foreground">
        Net of a {costPercent.toFixed(2)}% round-trip cost estimate. Whiskers are a 95% stationary
        block bootstrap interval; a tier whose whisker crosses zero has not been shown to have an
        edge. A hollow marker has no interval at all - too few independent blocks to compute one, so
        it is the least certain point on the chart, not the most.
      </p>
    </div>
  );
}
