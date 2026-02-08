'use client';

import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '@/stores/uiStore';
import { TradingChart } from './TradingChart';

export function DashboardChart() {
  const { selectedSymbol, selectedInterval, setSelectedInterval, chartType, setChartType } =
    useUIStore(
      useShallow((s) => ({
        selectedSymbol: s.selectedSymbol,
        selectedInterval: s.selectedInterval,
        setSelectedInterval: s.setSelectedInterval,
        chartType: s.chartType,
        setChartType: s.setChartType,
      }))
    );

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
