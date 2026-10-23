'use client';

import React from 'react';
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  ReferenceLine,
  ErrorBar,
} from 'recharts';
import type { ReliabilityPoint } from '@/types/calibration';
import { TIER_BUY_CUTOFF } from '@/lib/signals/calibration';
import { Panel } from '@/components/kit/Panel';
import { useChartTheme } from '@/lib/chart-theme';
import { cn } from '@/lib/utils';

export interface ReliabilityPanelProps {
  data: ReliabilityPoint[];
  className?: string;
}

function formatSignedPercent(val: number | null | undefined): string {
  if (val === null || val === undefined || isNaN(val)) return 'n/a';
  if (Math.abs(val) < 0.0001) return '0.00%';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}

export const ReliabilityPanel: React.FC<ReliabilityPanelProps> = ({
  data,
  className,
}) => {
  const chartTheme = useChartTheme();

  // Rule 5: Reliability points with a null mean are not plotted.
  const validPoints = data.filter((p) => p.meanPercent !== null);

  // Points with both bounds get an error bar
  const withBounds = validPoints
    .filter((p) => p.ciLowPercent !== null && p.ciHighPercent !== null)
    .map((p) => ({
      ...p,
      errorY: [
        Math.max(0, (p.meanPercent ?? 0) - (p.ciLowPercent ?? 0)),
        Math.max(0, (p.ciHighPercent ?? 0) - (p.meanPercent ?? 0)),
      ],
    }));

  // Points without bounds are plotted as hollow markers with no bar
  const withoutBounds = validPoints.filter(
    (p) => p.ciLowPercent === null || p.ciHighPercent === null
  );

  return (
    <Panel title="Reliability" className={cn('space-y-4', className)}>
      <div className="h-[280px] w-full" data-testid="reliability-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 20, right: 24, bottom: 20, left: 20 }}>
            <XAxis
              type="number"
              dataKey="scoreMid"
              name="Price score (signed)"
              domain={[0, (dataMax: number) => Math.max(40, isNaN(dataMax) ? 40 : dataMax)]}
              stroke={chartTheme.grid}
              tick={{ fill: chartTheme.mutedText, fontSize: 12 }}
              label={{
                value: 'Price score (signed)',
                position: 'insideBottom',
                offset: -4,
                style: { fill: chartTheme.mutedText, fontSize: 11 },
              }}
            />
            <YAxis
              type="number"
              dataKey="meanPercent"
              name="Mean return, before costs"
              stroke={chartTheme.grid}
              tick={{ fill: chartTheme.mutedText, fontSize: 12 }}
              tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`}
              width={80}
              label={{
                value: 'Mean return, before costs',
                angle: -90,
                position: 'insideLeft',
                style: { fill: chartTheme.mutedText, fontSize: 11, textAnchor: 'middle' },
              }}
            />
            <ZAxis range={[60, 60]} />
            <ReferenceLine
              x={TIER_BUY_CUTOFF}
              stroke={chartTheme.crosshair}
              strokeDasharray="3 3"
              label={{
                value: 'Buy cutoff',
                fill: chartTheme.mutedText,
                position: 'top',
                fontSize: 12,
              }}
            />
            <ReferenceLine y={0} stroke={chartTheme.grid} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload || !payload.length) return null;
                const pt = payload[0].payload as ReliabilityPoint;
                return (
                  <div className="bg-card border border-line rounded-[8px] p-2.5 text-[13px] shadow-none">
                    <p className="font-semibold text-foreground">
                      Score: [{pt.scoreLow}, {pt.scoreHigh}] (mid {pt.scoreMid})
                    </p>
                    <p className="font-sans tabular-nums text-foreground mt-0.5">
                      Mean return: {formatSignedPercent(pt.meanPercent)}
                    </p>
                    {pt.ciLowPercent !== null && pt.ciHighPercent !== null ? (
                      <p className="font-sans tabular-nums text-muted-foreground text-[12px] mt-0.5">
                        95% CI: [{formatSignedPercent(pt.ciLowPercent)},{' '}
                        {formatSignedPercent(pt.ciHighPercent)}]
                      </p>
                    ) : (
                      <p className="text-muted-foreground text-[12px] mt-0.5">
                        No interval
                      </p>
                    )}
                    <p className="font-sans tabular-nums text-muted-foreground text-[12px] mt-0.5">
                      Samples: {pt.count.toLocaleString()}
                    </p>
                  </div>
                );
              }}
            />
            {withBounds.length > 0 && (
              <Scatter
                name="With interval"
                data={withBounds}
                fill={chartTheme.up}
                shape="circle"
              >
                <ErrorBar
                  dataKey="errorY"
                  width={4}
                  strokeWidth={1.5}
                  stroke={chartTheme.mutedText}
                  direction="y"
                />
              </Scatter>
            )}
            {withoutBounds.length > 0 && (
              <Scatter
                name="No interval"
                data={withoutBounds}
                fill="transparent"
                stroke={chartTheme.mutedText}
                strokeWidth={2}
                shape="circle"
              />
            )}
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      {(withBounds.length > 0 || withoutBounds.length > 0) && (
        <div
          data-testid="reliability-legend"
          className="flex items-center justify-center gap-6 text-[12px] text-muted-foreground"
        >
          {withBounds.length > 0 && (
            <div className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: chartTheme.up }}
              />
              <span>With interval</span>
            </div>
          )}
          {withoutBounds.length > 0 && (
            <div className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full border border-current bg-transparent"
                style={{ borderColor: chartTheme.mutedText }}
              />
              <span>No interval</span>
            </div>
          )}
        </div>
      )}

      <p className="text-center text-[12px] text-muted-foreground font-sans">
        A score that carries information slopes up through zero. A sign error slopes down.
      </p>
    </Panel>
  );
};
