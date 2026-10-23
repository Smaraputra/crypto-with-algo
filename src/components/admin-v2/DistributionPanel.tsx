'use client';

import React, { useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';
import type { DistributionResponse } from '@/types/calibration';
import { Panel } from '@/components/kit/Panel';
import { useChartTheme } from '@/lib/chart-theme';
import { cn } from '@/lib/utils';

export interface DistributionPanelProps {
  data: DistributionResponse;
  className?: string;
}

const TIER_LABELS: Record<string, string> = {
  strong_buy: 'Strong buy',
  buy: 'Buy',
  neutral: 'Neutral',
  sell: 'Sell',
  strong_sell: 'Strong sell',
};

export function formatDistributionTick(v: number): string {
  const fixed = v.toFixed(1);
  if (fixed === '-0.0' || fixed === '0.0') return '0.0%';
  if (v > 0) return `+${fixed}%`;
  return `${fixed}%`;
}

export function formatSignedPercentTwoDecimals(v: number): string {
  const fixed = v.toFixed(2);
  if (fixed === '-0.00' || fixed === '0.00') return '0.00%';
  if (v > 0) return `+${fixed}%`;
  return `${fixed}%`;
}

function getBinFill(
  low: number,
  high: number,
  chartTheme: ReturnType<typeof useChartTheme>
): string {
  if (low < 0 && high > 0) {
    return chartTheme.crosshair;
  }
  if (high <= 0) {
    return chartTheme.down;
  }
  if (low >= 0) {
    return chartTheme.up;
  }
  return chartTheme.crosshair;
}

export const DistributionPanel: React.FC<DistributionPanelProps> = ({
  data,
  className,
}) => {
  const chartTheme = useChartTheme();
  const [selectedTier, setSelectedTier] = useState<string>('all');

  const { bins = [], tiers = [], clipped = {} } = data;

  const chartData = bins.map((bin) => {
    const mid = (bin.low + bin.high) / 2;
    let count = 0;
    if (selectedTier === 'all') {
      count =
        tiers.length > 0
          ? tiers.reduce((sum, t) => sum + (bin.counts[t] ?? 0), 0)
          : Object.values(bin.counts).reduce((sum, c) => sum + c, 0);
    } else {
      count = bin.counts[selectedTier] ?? 0;
    }
    return {
      mid,
      low: bin.low,
      high: bin.high,
      count,
    };
  });

  const clippedCount =
    selectedTier === 'all'
      ? Object.values(clipped).reduce((sum, val) => sum + val, 0)
      : (clipped[selectedTier] ?? 0);

  return (
    <Panel title="Return distribution" className={cn('space-y-4', className)}>
      {bins.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No return distribution data available.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <label
              htmlFor="tier-select"
              className="text-[13px] font-semibold text-muted-foreground"
            >
              Tier
            </label>
            <select
              id="tier-select"
              data-testid="tier-select"
              value={selectedTier}
              onChange={(e) => setSelectedTier(e.target.value)}
              className="rounded-[8px] border border-line bg-card px-2.5 py-1.5 text-[13px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground"
            >
              <option value="all">All tiers</option>
              {tiers.map((tier) => (
                <option key={tier} value={tier}>
                  {TIER_LABELS[tier] || tier}
                </option>
              ))}
            </select>
          </div>

          <div className="h-[280px] w-full" data-testid="distribution-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                margin={{ top: 20, right: 24, bottom: 10, left: 10 }}
              >
                <XAxis
                  type="number"
                  dataKey="mid"
                  domain={['dataMin', 'dataMax']}
                  stroke={chartTheme.grid}
                  tick={{ fill: chartTheme.mutedText, fontSize: 11 }}
                  tickFormatter={formatDistributionTick}
                />
                <YAxis
                  stroke={chartTheme.grid}
                  tick={{ fill: chartTheme.mutedText, fontSize: 12 }}
                  allowDecimals={false}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload || !payload.length) return null;
                    const pt = payload[0].payload as {
                      mid: number;
                      low: number;
                      high: number;
                      count: number;
                    };
                    const lowStr = formatSignedPercentTwoDecimals(pt.low);
                    const highStr = formatSignedPercentTwoDecimals(pt.high);
                    return (
                      <div className="bg-card border border-line rounded-[8px] p-2.5 text-[13px] shadow-none min-w-[140px]">
                        <p className="font-sans tabular-nums text-foreground">
                          {lowStr} to {highStr}: {pt.count.toLocaleString()} outcomes
                        </p>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="count" isAnimationActive={false}>
                  {chartData.map((entry) => (
                    <Cell
                      key={`bin-${entry.low}-${entry.high}`}
                      fill={getBinFill(entry.low, entry.high, chartTheme)}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {clippedCount > 0 && (
            <p className="text-[12px] text-muted-foreground font-sans tabular-nums">
              {clippedCount.toLocaleString()} outcomes clipped outside bin range.
            </p>
          )}
        </>
      )}
    </Panel>
  );
};
