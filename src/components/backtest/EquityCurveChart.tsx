'use client';

import { useEffect, useRef, useCallback } from 'react';
import { createChart, AreaSeries, type IChartApi, type ISeriesApi, ColorType } from 'lightweight-charts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { EquityPoint } from '@/lib/backtest/types';

interface EquityCurveChartProps {
  equityCurve: EquityPoint[];
  startEquity: number;
}

function formatUSD(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(value);
}

export function EquityCurveChart({ equityCurve, startEquity }: EquityCurveChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  const finalEquity = equityCurve.length > 0
    ? equityCurve[equityCurve.length - 1].equity
    : startEquity;
  const isProfitable = finalEquity >= startEquity;

  const lineColor = isProfitable ? '#0ecb81' : '#f6465d';
  const topColor = isProfitable ? 'rgba(14, 203, 129, 0.3)' : 'rgba(246, 70, 93, 0.3)';
  const bottomColor = isProfitable ? 'rgba(14, 203, 129, 0.0)' : 'rgba(246, 70, 93, 0.0)';

  const initChart = useCallback(() => {
    if (!chartContainerRef.current || equityCurve.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
      seriesRef.current = null;
    }

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#b3b3b3',
      },
      grid: {
        vertLines: { color: '#3b3b3b' },
        horzLines: { color: '#3b3b3b' },
      },
      width: chartContainerRef.current.clientWidth,
      height: 300,
      rightPriceScale: { borderColor: '#4d4d4d' },
      timeScale: { borderColor: '#4d4d4d' },
      crosshair: {
        horzLine: { color: '#777777' },
        vertLine: { color: '#777777' },
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

    const chartData = equityCurve.map((p) => ({
      time: Math.floor(p.time / 1000) as Parameters<typeof series.setData>[0][0]['time'],
      value: p.equity,
    }));

    series.setData(chartData);
    chart.timeScale().fitContent();

    chartRef.current = chart;
    seriesRef.current = series;
  }, [equityCurve, lineColor, topColor, bottomColor]);

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
    <Card data-testid="equity-curve-chart">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Equity Curve</CardTitle>
      </CardHeader>
      <CardContent>
        {equityCurve.length === 0 ? (
          <div
            className="flex h-[300px] items-center justify-center text-sm text-muted-foreground"
            data-testid="equity-chart-empty"
          >
            Run a backtest to see the equity curve
          </div>
        ) : (
          <div ref={chartContainerRef} data-testid="equity-chart-container" />
        )}
      </CardContent>
    </Card>
  );
}
