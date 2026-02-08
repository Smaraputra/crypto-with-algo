'use client';

import { useUIStore } from '@/stores/uiStore';
import { TradingChart } from './TradingChart';

export function DashboardChart() {
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const selectedInterval = useUIStore((s) => s.selectedInterval);
  const setSelectedInterval = useUIStore((s) => s.setSelectedInterval);
  const chartType = useUIStore((s) => s.chartType);
  const setChartType = useUIStore((s) => s.setChartType);

  return (
    <div className="h-[500px]">
      <TradingChart
        symbol={selectedSymbol}
        interval={selectedInterval}
        chartType={chartType}
        onIntervalChange={setSelectedInterval}
        onChartTypeChange={setChartType}
      />
    </div>
  );
}
