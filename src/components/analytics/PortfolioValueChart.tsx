'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { createChart, AreaSeries, type IChartApi, type ISeriesApi, ColorType } from 'lightweight-charts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { usePortfolioHistory } from '@/hooks/useAnalytics';
import type { PortfolioHistoryPoint } from '@/types/analytics';

const RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '1y', days: 365 },
] as const;

interface PortfolioValueChartProps {
  portfolioId: string | null;
}

function formatUSD(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(value);
}

export function PortfolioValueChart({ portfolioId }: PortfolioValueChartProps) {
  const [range, setRange] = useState(30);
  const { data, isLoading } = usePortfolioHistory(portfolioId, range);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  const history = data?.history ?? [];
  const hasData = history.length > 0;

  const isPositivePeriod =
    hasData && history[history.length - 1].totalValue >= history[0].totalValue;

  const lineColor = isPositivePeriod ? '#0ecb81' : '#f6465d';
  const topColor = isPositivePeriod ? 'rgba(14, 203, 129, 0.3)' : 'rgba(246, 70, 93, 0.3)';
  const bottomColor = isPositivePeriod ? 'rgba(14, 203, 129, 0.0)' : 'rgba(246, 70, 93, 0.0)';

  const initChart = useCallback(() => {
    if (!chartContainerRef.current || !hasData) return;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
      seriesRef.current = null;
    }

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'oklch(0.7 0 0)',
      },
      grid: {
        vertLines: { color: 'oklch(0.25 0 0)' },
        horzLines: { color: 'oklch(0.25 0 0)' },
      },
      width: chartContainerRef.current.clientWidth,
      height: 300,
      rightPriceScale: {
        borderColor: 'oklch(0.3 0 0)',
      },
      timeScale: {
        borderColor: 'oklch(0.3 0 0)',
      },
      crosshair: {
        horzLine: { color: 'oklch(0.5 0 0)' },
        vertLine: { color: 'oklch(0.5 0 0)' },
      },
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor,
      topColor,
      bottomColor,
      lineWidth: 2,
      priceFormat: {
        type: 'custom',
        formatter: (price: number) => formatUSD(price),
      },
    });

    const chartData = history.map((p: PortfolioHistoryPoint) => ({
      time: p.date.split('T')[0],
      value: p.totalValue,
    }));

    series.setData(chartData as Parameters<typeof series.setData>[0]);
    chart.timeScale().fitContent();

    chartRef.current = chart;
    seriesRef.current = series;
  }, [hasData, history, lineColor, topColor, bottomColor]);

  useEffect(() => {
    initChart();
    return () => {
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
        seriesRef.current = null;
      }
    };
  }, [initChart]);

  useEffect(() => {
    if (!chartContainerRef.current || !chartRef.current) return;

    const observer = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      chartRef.current?.applyOptions({ width });
    });

    observer.observe(chartContainerRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <Card data-testid="portfolio-value-chart">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">Portfolio Value</CardTitle>
        <div className="flex gap-1" data-testid="range-selector">
          {RANGES.map((r) => (
            <button
              key={r.label}
              onClick={() => setRange(r.days)}
              className={`rounded-sm px-2 py-0.5 text-xs transition-colors ${
                range === r.days
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              data-testid={`range-${r.label}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div
            className="h-[300px] animate-shimmer rounded-sm"
            data-testid="chart-skeleton"
          />
        )}
        {!isLoading && !hasData && (
          <div
            className="flex h-[300px] items-center justify-center text-sm text-muted-foreground"
            data-testid="chart-empty"
          >
            No snapshot data yet. Daily snapshots begin automatically.
          </div>
        )}
        {!isLoading && hasData && (
          <div ref={chartContainerRef} data-testid="chart-container" />
        )}
      </CardContent>
    </Card>
  );
}
