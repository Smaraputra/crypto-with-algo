'use client';

/**
 * Running sum of net per-signal return, one line per configVersion.
 *
 * THIS IS NOT AN EQUITY CURVE and the component says so on screen, not only in
 * a comment. Two reasons it cannot be read as one: there is no compounding and
 * no position sizing, and even in the non-overlapping default the signals are
 * sampled one per horizon per symbol, which is a set of trades that could be
 * taken sequentially but says nothing about what capital they would need.
 *
 * Series are split by configVersion because each version is a different scorer.
 * Splitting rather than pooling is what stops a line from crossing a scorer
 * change and being read as one continuous track record.
 *
 * Each line is direct-labelled at its end as well as carrying a legend entry,
 * so identity never rests on colour alone.
 */
import {
  CartesianGrid,
  LabelList,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { CumulativeSeriesRow } from '@/types/calibration';
import {
  AXIS_TICK,
  GRID_COLOR,
  TOOLTIP_STYLE,
  ZERO_LINE_COLOR,
  configVersionColor,
  formatPercent,
} from './chart-theme';

interface CumulativeReturnChartProps {
  series: CumulativeSeriesRow[];
  overlapping: boolean;
  horizonBars: number;
}

export function CumulativeReturnChart({
  series,
  overlapping,
  horizonBars,
}: CumulativeReturnChartProps) {
  const withPoints = series.filter((row) => row.points.length > 0);

  if (withPoints.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground" data-testid="cumulative-empty">
        No actionable signals have resolved yet, so there is nothing to accumulate.
      </p>
    );
  }

  // One row per timestamp across every version, so Recharts can share an axis
  // without the series being resampled onto a common grid.
  const byTimestamp = new Map<number, Record<string, number>>();
  for (const row of withPoints) {
    for (const point of row.points) {
      const existing = byTimestamp.get(point.candleTimestamp) ?? { candleTimestamp: point.candleTimestamp };
      existing[`v${row.configVersion}`] = point.cumulativePercent;
      byTimestamp.set(point.candleTimestamp, existing);
    }
  }
  const data = [...byTimestamp.values()].sort(
    (a, b) => (a.candleTimestamp as number) - (b.candleTimestamp as number)
  );

  // Index of each series' final non-null point, so the direct label lands at the
  // end of that line rather than at the end of the shared x-axis. Series do not
  // all end at the same timestamp: a retired configVersion stops early.
  const lastIndexOf = new Map<string, number>();
  data.forEach((row, index) => {
    for (const key of Object.keys(row)) {
      if (key !== 'candleTimestamp') lastIndexOf.set(key, index);
    }
  });

  return (
    <div data-testid="cumulative-return-chart">
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
          <CartesianGrid stroke={GRID_COLOR} strokeDasharray="2 4" />
          <XAxis
            dataKey="candleTimestamp"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tick={AXIS_TICK}
            stroke={GRID_COLOR}
            tickFormatter={(value: number) =>
              new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            }
          />
          <YAxis
            tick={AXIS_TICK}
            stroke={GRID_COLOR}
            tickFormatter={(value: number) => `${value.toFixed(1)}%`}
            label={{
              value: 'Cumulative net return',
              angle: -90,
              position: 'insideLeft',
              style: { fill: 'var(--color-muted-foreground)', fontSize: 11 },
            }}
          />
          <ReferenceLine y={0} stroke={ZERO_LINE_COLOR} strokeWidth={2} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value, name) => [formatPercent(Number(value)), String(name)]}
            labelFormatter={(label) => new Date(Number(label)).toLocaleString()}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {withPoints.map((row, index) => {
            const key = `v${row.configVersion}`;
            const color = configVersionColor(index);
            return (
              <Line
                key={row.configVersion}
                type="monotone"
                dataKey={key}
                name={`configVersion ${row.configVersion} (n=${row.count})`}
                stroke={color}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              >
                {/* Direct label at the line's own end: with this few series,
                    identity should not depend on matching a legend swatch. */}
                <LabelList
                  dataKey={key}
                  content={(props) => {
                    const { x, y, index: pointIndex } = props as {
                      x?: number;
                      y?: number;
                      index?: number;
                    };
                    if (x === undefined || y === undefined) return null;
                    if (pointIndex !== lastIndexOf.get(key)) return null;
                    return (
                      <text x={x + 6} y={y} fill={color} fontSize={10} dominantBaseline="middle">
                        v{row.configVersion}
                      </text>
                    );
                  }}
                />
              </Line>
            );
          })}
        </LineChart>
      </ResponsiveContainer>
      <p className="mt-1 text-center text-xs text-muted-foreground">
        {overlapping ? (
          <>
            <span className="text-bearish">Overlapping: not an achievable path.</span> Every signal
            is summed, so up to {horizonBars} positions per symbol are open at once.
          </>
        ) : (
          <>
            Non-overlapping: at most one signal per symbol per {horizonBars}-bar horizon. A running
            sum of per-signal percentage returns, not an equity curve - no compounding, no sizing.
          </>
        )}
      </p>
    </div>
  );
}
