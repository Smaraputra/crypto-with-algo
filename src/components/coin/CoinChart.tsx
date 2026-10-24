'use client';

import React, { useMemo, useState } from 'react';
import {
  useTradingChartEngine,
  DRAWING_TOOLS,
  type IndicatorConfig,
} from '@/components/chart/useTradingChartEngine';
import { describeCall } from '@/components/chart/signal-calls-indicator';
import { CallsLegend } from '@/components/kit';
import { SegmentedControl, type SegmentedControlOption } from '@/components/kit/SegmentedControl';
import { StateNotice } from '@/components/kit/StateNotice';
import { useChartCalls } from '@/hooks/useChartCalls';
import { useFocusMtf } from '@/hooks/useFocusMtf';
import { useSignalLabV4 } from '@/hooks/useSignalLabV4';
import { MTF_INTERVAL_MS, type MtfInterval } from '@/lib/market/mtf';
import { cn } from '@/lib/utils';

export interface CoinChartProps {
  symbol: string;
  className?: string;
}

const EMPTY_INDICATORS: IndicatorConfig[] = [];

const INTERVAL_OPTIONS: SegmentedControlOption[] = [
  { label: '15m', value: '15m' },
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '1d', value: '1d' },
];

function renderDrawingIcon(id: string) {
  switch (id) {
    case 'segment':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="4" cy="14" r="2" fill="currentColor" />
          <circle cx="14" cy="4" r="2" fill="currentColor" />
          <line x1="5.5" y1="12.5" x2="12.5" y2="5.5" />
        </svg>
      );
    case 'horizontalStraightLine':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <line x1="2" y1="9" x2="16" y2="9" />
        </svg>
      );
    case 'rayLine':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="4" cy="14" r="2" fill="currentColor" />
          <line x1="5.5" y1="12.5" x2="16" y2="2" />
        </svg>
      );
    case 'straightLine':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <line x1="2" y1="16" x2="16" y2="2" />
        </svg>
      );
    case 'horizontalRayLine':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="4" cy="9" r="2" fill="currentColor" />
          <line x1="6" y1="9" x2="16" y2="9" />
        </svg>
      );
    case 'verticalStraightLine':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <line x1="9" y1="2" x2="9" y2="16" />
        </svg>
      );
    case 'fibonacciLine':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <line x1="2" y1="4" x2="16" y2="4" />
          <line x1="2" y1="8" x2="16" y2="8" strokeDasharray="2 2" />
          <line x1="2" y1="11" x2="16" y2="11" strokeDasharray="2 2" />
          <line x1="2" y1="14" x2="16" y2="14" />
        </svg>
      );
    case 'parallelStraightLine':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <line x1="2" y1="12" x2="13" y2="2" />
          <line x1="5" y1="16" x2="16" y2="6" />
        </svg>
      );
    default:
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="9" cy="9" r="4" />
        </svg>
      );
  }
}

export const CoinChart: React.FC<CoinChartProps> = ({ symbol, className }) => {
  const [interval, setInterval] = useState<string>('1h');
  const [showInternal, setShowInternal] = useState<boolean>(false);
  const [showSma, setShowSma] = useState<boolean>(false);
  const [showMacd, setShowMacd] = useState<boolean>(false);
  const [showDrawTools, setShowDrawTools] = useState<boolean>(false);

  const { data: mtfData } = useFocusMtf(symbol);
  const { data: labV4Data } = useSignalLabV4(symbol);

  const labMarks = useMemo(() => {
    if (!labV4Data?.hypotheses) return [];
    const marks: { time: number; side: 1 | -1; label: 'S1' | 'S2' }[] = [];
    const seen = new Set<string>();

    for (const hyp of labV4Data.hypotheses) {
      const label =
        hyp.candidate === 'S1' || hyp.candidate === 'S2'
          ? hyp.candidate
          : hyp.id.startsWith('S1')
            ? 'S1'
            : 'S2';

      if (hyp.openTrades) {
        for (const trade of hyp.openTrades) {
          if (trade.symbol === symbol) {
            const time = new Date(trade.enteredAt).getTime();
            if (!Number.isNaN(time)) {
              const key = `${time}-${label}`;
              if (!seen.has(key)) {
                seen.add(key);
                marks.push({ time, side: trade.side, label });
              }
            }
          }
        }
      }

      if (hyp.latestBar?.entries && hyp.latestBar.barClose) {
        for (const entry of hyp.latestBar.entries) {
          if (entry.symbol === symbol) {
            const time = new Date(hyp.latestBar.barClose).getTime();
            if (!Number.isNaN(time)) {
              const key = `${time}-${label}`;
              if (!seen.has(key)) {
                seen.add(key);
                marks.push({ time, side: entry.side, label });
              }
            }
          }
        }
      }
    }

    if (labV4Data.entries) {
      for (const entry of labV4Data.entries) {
        if (entry.symbol === symbol) {
          const time = new Date(entry.barClose).getTime();
          const label = entry.hypothesis.startsWith('S1') ? 'S1' : 'S2';
          if (!Number.isNaN(time)) {
            const key = `${time}-${label}`;
            if (!seen.has(key)) {
              seen.add(key);
              marks.push({ time, side: entry.side, label });
            }
          }
        }
      }
    }

    return marks;
  }, [labV4Data, symbol]);

  const intervalMs = MTF_INTERVAL_MS[interval as MtfInterval] ?? 3_600_000;

  const focusOverlay = useMemo(
    () => ({
      intervalMs,
      showInternal,
      showSma,
      showMacd,
      priorDay: mtfData?.priorDay ?? null,
      labMarks,
    }),
    [intervalMs, showInternal, showSma, showMacd, mtfData?.priorDay, labMarks]
  );

  const calls = useChartCalls(symbol, interval);

  const {
    containerRef,
    isLoading,
    historyError,
    handleRefresh,
    activeDrawingTool,
    activateDrawingTool,
    clearDrawings,
    magnetMode,
    toggleMagnetMode,
    hoverCall,
    callsHorizon,
    callsCost,
  } = useTradingChartEngine({
    symbol,
    interval,
    market: 'perp',
    initialIndicators: EMPTY_INDICATORS,
    showCandleTooltip: false,
    focusOverlay,
    callsOverlay: calls.callsOverlay,
    onLoadedRangeChange: calls.onLoadedRangeChange,
    onVisibleRangeChange: calls.onVisibleRangeChange,
  });

  return (
    <section aria-label="Coin chart" className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <SegmentedControl
            legend="Interval"
            options={INTERVAL_OPTIONS}
            value={interval}
            onChange={(val) => setInterval(val)}
          />

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-pressed={showInternal}
              onClick={() => setShowInternal((prev) => !prev)}
              className={cn(
                'min-h-[44px] h-[44px] px-3.5 inline-flex items-center justify-center rounded-[12px] border text-[14px] font-semibold cursor-pointer select-none transition-colors duration-120 active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100',
                'focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px]',
                showInternal
                  ? 'bg-foreground text-background border-foreground'
                  : 'bg-card text-ink-2 border-edge hover:bg-muted hover:text-foreground'
              )}
            >
              Structure
            </button>

            <button
              type="button"
              aria-pressed={showSma}
              onClick={() => setShowSma((prev) => !prev)}
              className={cn(
                'min-h-[44px] h-[44px] px-3.5 inline-flex items-center justify-center rounded-[12px] border text-[14px] font-semibold cursor-pointer select-none transition-colors duration-120 active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100',
                'focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px]',
                showSma
                  ? 'bg-foreground text-background border-foreground'
                  : 'bg-card text-ink-2 border-edge hover:bg-muted hover:text-foreground'
              )}
            >
              50 SMA
            </button>

            <button
              type="button"
              aria-pressed={showMacd}
              onClick={() => setShowMacd((prev) => !prev)}
              className={cn(
                'min-h-[44px] h-[44px] px-3.5 inline-flex items-center justify-center rounded-[12px] border text-[14px] font-semibold cursor-pointer select-none transition-colors duration-120 active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100',
                'focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px]',
                showMacd
                  ? 'bg-foreground text-background border-foreground'
                  : 'bg-card text-ink-2 border-edge hover:bg-muted hover:text-foreground'
              )}
            >
              MACD
            </button>
          </div>
        </div>

        <button
          type="button"
          aria-expanded={showDrawTools}
          onClick={() => setShowDrawTools((prev) => !prev)}
          className={cn(
            'min-h-[44px] h-[44px] px-3.5 inline-flex items-center gap-1.5 justify-center rounded-[12px] border text-[14px] font-semibold cursor-pointer select-none transition-colors duration-120',
            'focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px]',
            showDrawTools
              ? 'bg-muted text-foreground border-foreground'
              : 'bg-card text-foreground border-edge hover:bg-muted'
          )}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className="w-4 h-4 shrink-0"
          >
            <path
              d="M12 2l2 2-8 8H4v-2l8-8z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Draw</span>
        </button>
      </div>

      {showDrawTools && (
        <div
          role="toolbar"
          aria-label="Drawing tools"
          className="flex items-center gap-1.5 p-1.5 bg-card border border-edge rounded-[12px] flex-wrap"
        >
          {DRAWING_TOOLS.map((tool) => {
            const isActive = activeDrawingTool === tool.id;
            return (
              <button
                key={tool.id}
                type="button"
                aria-label={tool.label}
                aria-pressed={isActive}
                onClick={() => activateDrawingTool(tool.id)}
                className={cn(
                  'w-11 h-11 min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-[8px] border transition-colors duration-120 cursor-pointer',
                  'focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px]',
                  isActive
                    ? 'bg-foreground text-background border-foreground'
                    : 'border-transparent text-foreground hover:bg-muted'
                )}
              >
                {renderDrawingIcon(tool.id)}
              </button>
            );
          })}

          <div className="w-[1px] h-6 bg-line mx-1" aria-hidden="true" />

          <button
            type="button"
            aria-pressed={magnetMode !== 'normal'}
            onClick={toggleMagnetMode}
            className={cn(
              'min-h-[44px] h-[44px] px-3.5 inline-flex items-center justify-center rounded-[8px] border text-[13px] font-semibold transition-colors duration-120 cursor-pointer select-none',
              'focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px]',
              magnetMode !== 'normal'
                ? 'bg-foreground text-background border-foreground'
                : 'border-edge bg-card text-foreground hover:bg-muted'
            )}
          >
            Magnet
          </button>

          <button
            type="button"
            onClick={clearDrawings}
            className={cn(
              'min-h-[44px] h-[44px] px-3.5 inline-flex items-center justify-center rounded-[8px] border border-edge bg-card text-[13px] font-semibold text-foreground hover:bg-muted transition-colors duration-120 cursor-pointer select-none',
              'focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px]'
            )}
          >
            Clear drawings
          </button>
        </div>
      )}

      <div className="relative h-[360px] lg:h-[520px] w-full rounded-panel bg-card overflow-hidden">
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
