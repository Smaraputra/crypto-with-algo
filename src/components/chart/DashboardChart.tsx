'use client';

import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '@/stores/uiStore';
import { useProvisionalSignal } from '@/hooks/useProvisionalSignal';
import type { TradingStyle } from '@/lib/models/signal-template';
import { isProvisionalEligible } from '@/lib/signals/provisional/styles';
import { TradingChart } from './TradingChart';
import { SignalScoreStrip, resolveStyle } from './SignalScoreStrip';

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
  const [dailyStyle, setDailyStyle] = useState<TradingStyle | null>(null);
  const style = resolveStyle(selectedInterval, dailyStyle);
  const signal = useProvisionalSignal(selectedSymbol, selectedInterval, style);

  const overlayVisible =
    isProvisionalEligible(selectedSymbol, selectedInterval, style) && signal.status !== 'unavailable';
  const overlayState =
    signal.status === 'provisional' || signal.status === 'awaiting-record' ? signal.status : null;

  return (
    <div>
      <div className="h-[500px]">
        <TradingChart
          symbol={selectedSymbol}
          interval={selectedInterval}
          chartType={chartType}
          onIntervalChange={setSelectedInterval}
          onChartTypeChange={setChartType}
          signalOverlay={{
            visible: overlayVisible,
            recorded: signal.recorded,
            provisional: signal.provisional,
            state: overlayState,
          }}
        />
      </div>
      <SignalScoreStrip
        symbol={selectedSymbol}
        interval={selectedInterval}
        style={style}
        signal={signal}
        onStyleChange={setDailyStyle}
      />
    </div>
  );
}
