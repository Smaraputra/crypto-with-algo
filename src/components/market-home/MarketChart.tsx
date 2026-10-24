'use client';

import React from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useTradingChartEngine, type IndicatorConfig } from '@/components/chart/useTradingChartEngine';
import { describeCall } from '@/components/chart/signal-calls-indicator';
import { CallsLegend } from '@/components/kit';
import { SegmentedControl, type SegmentedControlOption } from '@/components/kit/SegmentedControl';
import { StateNotice } from '@/components/kit/StateNotice';
import { useChartCalls } from '@/hooks/useChartCalls';
import { cn } from '@/lib/utils';

export interface MarketChartProps {
  className?: string;
}

const EMPTY_INDICATORS: IndicatorConfig[] = [];

const VALID_INTERVALS = ['1h', '4h', '1d', '1w', '1M'] as const;
type ValidInterval = (typeof VALID_INTERVALS)[number];

const INTERVAL_OPTIONS: SegmentedControlOption[] = [
  { label: '1H', value: '1h' },
  { label: '4H', value: '4h' },
  { label: '1D', value: '1d' },
  { label: '1W', value: '1w' },
  { label: '1M', value: '1M' },
];

export const MarketChart: React.FC<MarketChartProps> = ({ className }) => {
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const storedInterval = useUIStore((s) => s.selectedInterval);
  const setSelectedInterval = useUIStore((s) => s.setSelectedInterval);

  const currentInterval: ValidInterval = (
    VALID_INTERVALS as readonly string[]
  ).includes(storedInterval)
    ? (storedInterval as ValidInterval)
    : '1h';

  const calls = useChartCalls(selectedSymbol, currentInterval);

  const {
    containerRef,
    isLoading,
    historyError,
    handleRefresh,
    hoverCall,
    callsHorizon,
    callsCost,
  } = useTradingChartEngine({
    symbol: selectedSymbol,
    interval: currentInterval,
    chartType: 'candle_solid',
    initialIndicators: EMPTY_INDICATORS,
    showCandleTooltip: false,
    restoreOverlays: false,
    callsOverlay: calls.callsOverlay,
    onLoadedRangeChange: calls.onLoadedRangeChange,
    onVisibleRangeChange: calls.onVisibleRangeChange,
  });

  return (
    <section aria-label="Market chart" className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center justify-between">
        <SegmentedControl
          legend="Interval"
          options={INTERVAL_OPTIONS}
          value={currentInterval}
          onChange={(val) => setSelectedInterval(val)}
        />
      </div>

      <div className="relative h-[300px] lg:h-[420px] w-full rounded-panel bg-card overflow-hidden">
        {historyError ? (
          <div className="h-full flex items-center justify-center p-4">
            <StateNotice
              kind="error"
              title="The chart did not load."
              description="Price history did not answer. Try again in a minute."
              action={
                <button
                  type="button"
                  onClick={handleRefresh}
                  className={cn(
                    'min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[12px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer',
                    'hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline transition-colors duration-120',
                    'active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100'
                  )}
                >
                  Try again
                </button>
              }
              className="max-w-md w-full"
            />
          </div>
        ) : (
          <>
            <div ref={containerRef} data-testid="chart-container" className="h-full w-full" />
            {isLoading && (
              <div
                role="status"
                aria-busy="true"
                className="absolute inset-0 z-10 flex items-center justify-center bg-card/60 backdrop-blur-[1px]"
              >
                <p className="text-[14px] font-medium text-muted-foreground">
                  Loading the chart.
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {!historyError && (
        <CallsLegend
          show={calls.show}
          onShowChange={calls.setShow}
          eligible={calls.eligible}
          ineligibleReason={calls.ineligibleReason}
          tally={calls.tally}
          error={calls.error}
          hoverText={hoverCall ? describeCall(hoverCall, callsHorizon, callsCost) : null}
        />
      )}
    </section>
  );
};
