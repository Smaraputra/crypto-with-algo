'use client';

import dynamic from 'next/dynamic';
import type { TradingChartProps } from '@/components/chart/TradingChart';

const TradingChart = dynamic(
  () => import('@/components/chart/TradingChart').then((m) => m.TradingChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full rounded-sm border border-border animate-shimmer" />
    ),
  }
);

export function LazyFocusChart(props: TradingChartProps) {
  return <TradingChart {...props} />;
}
