'use client';

import React from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';
import type { CumulativeSeriesRow } from '@/types/calibration';
import { Panel } from '@/components/kit/Panel';
import { useChartTheme } from '@/lib/chart-theme';
import { cn } from '@/lib/utils';

export interface CumulativePanelProps {
  data: CumulativeSeriesRow[];
  className?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatCumulativeTick(timestamp: number): string {
  const d = new Date(timestamp);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function formatCumulativeTooltipDate(timestamp: number): string {
  const d = new Date(timestamp);
  const month = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const mins = String(d.getUTCMinutes()).padStart(2, '0');
  return `${month} ${day}, ${year}, ${hours}:${mins}`;
}

function formatSignedPercent(val: number | null | undefined): string {
  if (val === null || val === undefined || isNaN(val)) return 'n/a';
  if (Math.abs(val) < 0.0001) return '0.00%';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}

export const CumulativePanel: React.FC<CumulativePanelProps> = ({ data, className }) => {
  const chartTheme = useChartTheme();

  const activeSeries = data.filter((s) => s.points && s.points.length > 0);
  const emptySeries = data.filter((s) => !s.points || s.points.length === 0);

  const newestVersion =
    activeSeries.length > 0
      ? Math.max(...activeSeries.map((s) => s.configVersion))
      : null;

  // Merge active series by timestamp
  const timestampSet = new Set<number>();
  for (const s of activeSeries) {
    for (const pt of s.points) {
      timestampSet.add(pt.candleTimestamp);
    }
  }

  const sortedTimestamps = Array.from(timestampSet).sort((a, b) => a - b);

  const chartData = sortedTimestamps.map((ts) => {
    const row: Record<string, number> = { timestamp: ts };
    for (const s of activeSeries) {
      const pt = s.points.find((p) => p.candleTimestamp === ts);
      if (pt !== undefined) {
        row[`v${s.configVersion}`] = pt.cumulativePercent;
      }
    }
    return row;
  });

  return (
    <Panel title="Cumulative return" className={cn('space-y-4', className)}>
      {activeSeries.length === 0 ? (
        <div className="space-y-2">
          <p className="text-[13px] text-muted-foreground">
            No cumulative return data available.
          </p>
          {emptySeries.length > 0 && (
            <p className="text-[13px] text-muted-foreground font-sans">
              No outcomes yet: {emptySeries.map((s) => `v${s.configVersion}`).join(', ')}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="h-[280px] w-full" data-testid="cumulative-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 20, right: 24, bottom: 10, left: 10 }}
              >
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  minTickGap={48}
                  stroke={chartTheme.grid}
                  tick={{ fill: chartTheme.mutedText, fontSize: 12 }}
                  tickFormatter={(v) => formatCumulativeTick(Number(v))}
                />
                <YAxis
                  stroke={chartTheme.grid}
                  tick={{ fill: chartTheme.mutedText, fontSize: 12 }}
                  tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`}
                />
                <ReferenceLine y={0} stroke={chartTheme.grid} />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || !payload.length) return null;
                    return (
                      <div className="bg-card border border-line rounded-[8px] p-2.5 text-[13px] shadow-none min-w-[130px]">
                        <p className="font-semibold text-foreground mb-1">
                          {formatCumulativeTooltipDate(Number(label))}
                        </p>
                        <div className="space-y-1">
                          {payload.map((p, pIdx) => (
                            <div
                              key={String(p.dataKey ?? pIdx)}
                              className="flex items-center justify-between gap-3 text-[12px] text-muted-foreground"
                            >
                              <span className="flex items-center gap-1.5">
                                <span
                                  className="w-2 h-2 rounded-full"
                                  style={{ backgroundColor: p.color }}
                                />
                                <span>{p.name}:</span>
                              </span>
                              <span className="font-sans tabular-nums text-foreground font-semibold">
                                {formatSignedPercent(Number(p.value))}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  }}
                />
                <Legend />
                {activeSeries.map((s) => {
                  const isNewest = s.configVersion === newestVersion;
                  const stroke = isNewest ? chartTheme.text : chartTheme.crosshair;
                  const strokeDasharray = isNewest ? undefined : '4 3';

                  return (
                    <Line
                      key={s.configVersion}
                      type="linear"
                      dataKey={`v${s.configVersion}`}
                      name={`v${s.configVersion}`}
                      stroke={stroke}
                      strokeDasharray={strokeDasharray}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {emptySeries.length > 0 && (
            <p className="text-[13px] text-muted-foreground mt-2 font-sans">
              No outcomes yet: {emptySeries.map((s) => `v${s.configVersion}`).join(', ')}
            </p>
          )}
        </>
      )}
    </Panel>
  );
};
