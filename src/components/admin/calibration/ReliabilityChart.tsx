'use client';

/**
 * The reliability curve: mean signed forward return against signed score bucket.
 *
 * This is the chart that tests the premise the rest of the system rests on. If
 * the score carries directional information, the points slope up through the
 * origin. Flat means the score is uninformative at this interval. Sloping down
 * means it is inverted, which is a finding rather than a failure.
 *
 * Both axes are signed for that reason: the directional return used on the tier
 * chart folds the predicted direction into the value, which would map an
 * inverted score onto the same curve as a correct one and hide the case worth
 * catching.
 *
 * Buckets are score ranges, not the five named tiers, because the tier cutoffs
 * are themselves under test -- a view built on them would assume its conclusion.
 * A reference line marks the current buy cutoff so the cutoff can be read
 * against the curve rather than baked into it.
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

import type { ReliabilityPoint } from '@/types/calibration';
import {
  AXIS_TICK,
  GRID_COLOR,
  TOOLTIP_STYLE,
  ZERO_LINE_COLOR,
  formatCount,
  formatPercent,
} from './chart-theme';

interface ReliabilityChartProps {
  points: ReliabilityPoint[];
  /** Absolute score at which a signal becomes actionable, drawn either side. */
  buyCutoff: number;
}

interface PlotPoint {
  scoreMid: number;
  mean: number;
  error: [number, number];
  count: number;
  hasCi: boolean;
  scoreLow: number;
  scoreHigh: number;
}

export function ReliabilityChart({ points, buyCutoff }: ReliabilityChartProps) {
  const plotted: PlotPoint[] = points
    .filter((point) => point.meanPercent !== null)
    .map((point) => {
      const mean = point.meanPercent as number;
      const hasCi = point.ciLowPercent !== null && point.ciHighPercent !== null;
      return {
        scoreMid: point.scoreMid,
        mean,
        error: hasCi
          ? [mean - (point.ciLowPercent as number), (point.ciHighPercent as number) - mean]
          : [0, 0],
        count: point.count,
        hasCi,
        scoreLow: point.scoreLow,
        scoreHigh: point.scoreHigh,
      };
    });

  if (plotted.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground" data-testid="reliability-empty">
        No score bucket has enough resolved outcomes to estimate a mean return yet.
      </p>
    );
  }

  return (
    <div data-testid="reliability-chart">
      <ResponsiveContainer width="100%" height={280}>
        <ScatterChart margin={{ top: 16, right: 16, bottom: 16, left: 12 }}>
          <CartesianGrid stroke={GRID_COLOR} strokeDasharray="2 4" />
          <XAxis
            type="number"
            dataKey="scoreMid"
            tick={AXIS_TICK}
            stroke={GRID_COLOR}
            label={{
              value: 'Signal score (signed)',
              position: 'insideBottom',
              offset: -8,
              style: { fill: 'var(--color-muted-foreground)', fontSize: 11 },
            }}
          />
          <YAxis
            type="number"
            dataKey="mean"
            tick={AXIS_TICK}
            stroke={GRID_COLOR}
            tickFormatter={(value: number) => `${value.toFixed(2)}%`}
            width={72}
            label={{
              value: 'Mean forward return %',
              angle: -90,
              position: 'insideLeft',
              style: { fill: 'var(--color-muted-foreground)', fontSize: 11, textAnchor: 'middle' },
            }}
          />
          <ReferenceLine y={0} stroke={ZERO_LINE_COLOR} strokeWidth={2} />
          <ReferenceLine x={0} stroke={ZERO_LINE_COLOR} strokeWidth={2} />
          {/* insideTop, not top: a label positioned outside the plot area is
              clipped by the chart's own margin. */}
          <ReferenceLine
            x={buyCutoff}
            stroke="var(--color-accent)"
            strokeDasharray="4 4"
            label={{
              value: 'buy cutoff',
              fill: 'var(--color-accent)',
              fontSize: 10,
              position: 'insideTopLeft',
            }}
          />
          <ReferenceLine
            x={-buyCutoff}
            stroke="var(--color-accent)"
            strokeDasharray="4 4"
            label={{
              value: 'sell cutoff',
              fill: 'var(--color-accent)',
              fontSize: 10,
              position: 'insideTopRight',
            }}
          />
          <Tooltip
            cursor={{ stroke: GRID_COLOR }}
            contentStyle={TOOLTIP_STYLE}
            formatter={(_value, _name, item) => {
              const point = item?.payload as PlotPoint | undefined;
              if (!point) return null;
              const ci = point.hasCi
                ? `${formatPercent(point.mean - point.error[0])} to ${formatPercent(point.mean + point.error[1])}`
                : 'interval withheld';
              return [
                `${formatPercent(point.mean)} (${ci}), n=${formatCount(point.count)}`,
                `score ${point.scoreLow} to ${point.scoreHigh}`,
              ];
            }}
            labelFormatter={() => ''}
          />
          {/* Two series, split on whether an interval could be computed. A
              bucket with no interval drawn as a filled dot reads as the most
              precise point on the plot when it is the least; hollow says so. */}
          <Scatter
            data={plotted.filter((point) => point.hasCi)}
            fill="var(--color-chart-4)"
            shape="circle"
            isAnimationActive={false}
            name="Mean forward return"
          >
            <ErrorBar
              dataKey="error"
              direction="y"
              width={6}
              strokeWidth={2}
              stroke="var(--color-muted-foreground)"
            />
          </Scatter>
          <Scatter
            data={plotted.filter((point) => !point.hasCi)}
            fill="transparent"
            stroke="var(--color-chart-4)"
            strokeWidth={2}
            shape="circle"
            isAnimationActive={false}
            name="No interval (too few blocks)"
          />
        </ScatterChart>
      </ResponsiveContainer>
      <p className="mt-1 text-center text-xs text-muted-foreground">
        Signed score against signed forward return, before cost. An informative score slopes up
        through the origin; flat means uninformative and downward means inverted. Hollow markers
        are buckets with too few independent blocks to support an interval.
      </p>
    </div>
  );
}
