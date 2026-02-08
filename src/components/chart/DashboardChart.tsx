'use client';

import { useUIStore } from '@/stores/uiStore';
import { TradingChart } from './TradingChart';

export function DashboardChart() {
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const selectedInterval = useUIStore((s) => s.selectedInterval);
  const setSelectedInterval = useUIStore((s) => s.setSelectedInterval);

  return (
    <div className="h-[500px]">
      <TradingChart
        symbol={selectedSymbol}
        interval={selectedInterval}
        onIntervalChange={setSelectedInterval}
      />
    </div>
  );
}
