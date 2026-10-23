'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  init,
  dispose,
  type Chart,
  type CandleType,
  type Crosshair,
  type DataLoaderGetBarsParams,
  type DataLoaderSubscribeBarParams,
  type KLineData,
  type OverlayMode,
  type Period,
  type Point,
} from 'klinecharts';
import { useChartResize } from '@/hooks/useChartResize';
import { getDefaultCalcParams } from './indicator-params';
import { useFormingBarStore } from '@/stores/formingBarStore';
import {
  SIGNAL_SCORE_INDICATOR,
  SIGNAL_SCORE_PANE_ID,
  ensureSignalScoreIndicatorRegistered,
  makeSignalScoreCalc,
  type OverlayState,
  type RecordedScore,
  type RescoredScore,
} from './signal-score-indicator';
import {
  SIGNAL_CALLS_INDICATOR,
  ensureSignalCallsIndicatorRegistered,
  makeSignalCallsCalc,
} from './signal-calls-indicator';
import {
  CVD_INDICATOR,
  CVD_PANE_HEIGHT,
  CVD_PANE_ID,
  DELTA_VOL_INDICATOR,
  DELTA_VOL_PANE_HEIGHT,
  DELTA_VOL_PANE_ID,
  STRUCTURE_INDICATOR,
  ensureFocusIndicatorsRegistered,
  makeStructureCalc,
} from './focus-indicators';
import type { CallMark } from '@/lib/signals/track-record/chart-data';
import type { ProvisionalScore } from '@/lib/signals/provisional/types';
import { saveOverlays, loadOverlays, clearOverlays, type SerializedOverlay } from '@/lib/chart-storage';
import { getStreamClient, type StreamMarket } from '@/lib/market-stream/client';
import { klineStream } from '@/lib/market-stream/streams';
import { useMarketStreamStatus } from '@/hooks/useMarketStream';
import { useChartTheme } from '@/lib/chart-theme';
import { buildChartStyles } from './chart-styles';
import { setIndicatorTheme } from './indicator-theme';

interface BinanceKline {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  V: string;
  x: boolean;
}

export interface TimeRange {
  from: number;
  to: number;
}

export interface SignalOverlay {
  visible: boolean;
  recorded: ReadonlyMap<number, RecordedScore>;
  provisional: ProvisionalScore | null;
  state: OverlayState;
  /** Track-record bars computed after the fact; drawn only where nothing is recorded. */
  rescored?: ReadonlyMap<number, RescoredScore>;
}

export interface CallsOverlay {
  visible: boolean;
  calls: ReadonlyMap<number, CallMark>;
  boundary: number | null;
  horizonBars: number;
  costPercent: number;
}

export interface IndicatorConfig {
  id: string;
  name: string;
  category: 'overlay' | 'oscillator' | 'volume';
  enabled: boolean;
  calcParams: number[];
}

export interface TradingChartEngineOptions {
  symbol: string;
  interval: string;
  /** Candle source: spot (default) or USDT-M perpetuals. */
  market?: StreamMarket;
  chartType?: CandleType;
  /** Indicators configured on chart; defaults to DEFAULT_INDICATORS. */
  initialIndicators?: IndicatorConfig[];
  /** Whether candle tooltip is shown; defaults to true. */
  showCandleTooltip?: boolean;
  /** Draws the signal score pane. Never persisted and not part of IndicatorSettings. */
  signalOverlay?: SignalOverlay;
  /** Past calls and the re-score/live hand-over line on the price pane. */
  callsOverlay?: CallsOverlay;
  /** Focus page preset: no default indicators; structure, delta volume and CVD instead. */
  focusOverlay?: {
    intervalMs: number;
    showInternal: boolean;
    showSma: boolean;
    showMacd: boolean;
    priorDay: { high: number; low: number; close: number } | null;
    labMarks?: { time: number; side: 1 | -1; label: 'S1' | 'S2' }[];
  };
  /** The loaded bars changed: first load, an older page, or a new bar. Open times, ms. */
  onLoadedRangeChange?: (range: TimeRange) => void;
  /** The visible window changed (debounced). Open times, ms. */
  onVisibleRangeChange?: (range: TimeRange) => void;
  /** Whether saved drawings are loaded from and written to storage; defaults to true. */
  restoreOverlays?: boolean;
}

/**
 * The bar under the crosshair. KlineCharts 10.0.0-beta1 hands onCrosshairChange
 * the raw pointer ({ x, y, paneId }), not the enriched crosshair, so kLineData
 * is never set there; resolve the bar from x instead.
 */
export function barAtCrosshair(chart: Chart, crosshair: Crosshair | null | undefined): KLineData | null {
  if (crosshair?.kLineData) return crosshair.kLineData;
  if (typeof crosshair?.x !== 'number') return null;
  const points = chart.convertFromPixel([{ x: crosshair.x }], { paneId: 'candle_pane' }) as Array<Partial<Point>>;
  const index = points[0]?.dataIndex;
  const list = chart.getDataList();
  return typeof index === 'number' && index >= 0 && index < list.length ? list[index] : null;
}

/** True when the chart no longer shows the symbol and period a load was asked for. */
export function isStalePage(chart: Chart | null, params: Pick<DataLoaderGetBarsParams, 'symbol' | 'period'>): boolean {
  if (!chart) return true;
  const symbol = chart.getSymbol();
  const period = chart.getPeriod();
  return (
    symbol?.ticker !== params.symbol.ticker ||
    period?.type !== params.period.type ||
    period?.span !== params.period.span
  );
}

/** Bars per request when paging older history in. */
export const HISTORY_PAGE_BARS = 1000;
const VISIBLE_RANGE_DEBOUNCE_MS = 200;
const NO_CALLS: ReadonlyMap<number, CallMark> = new Map();

export const CHART_TYPES: { value: CandleType; label: string }[] = [
  { value: 'candle_solid', label: 'Candles' },
  { value: 'candle_stroke', label: 'Hollow' },
  { value: 'ohlc', label: 'OHLC' },
  { value: 'area', label: 'Area' },
];

export const DEFAULT_INDICATORS: IndicatorConfig[] = [
  { id: 'MA', name: 'Moving Average', category: 'overlay', enabled: true, calcParams: getDefaultCalcParams('MA') },
  { id: 'EMA', name: 'EMA', category: 'overlay', enabled: false, calcParams: getDefaultCalcParams('EMA') },
  { id: 'BOLL', name: 'Bollinger Bands', category: 'overlay', enabled: false, calcParams: getDefaultCalcParams('BOLL') },
  { id: 'SAR', name: 'Parabolic SAR', category: 'overlay', enabled: false, calcParams: getDefaultCalcParams('SAR') },
  { id: 'VOL', name: 'Volume', category: 'volume', enabled: true, calcParams: getDefaultCalcParams('VOL') },
  { id: 'MACD', name: 'MACD', category: 'oscillator', enabled: false, calcParams: getDefaultCalcParams('MACD') },
  { id: 'RSI', name: 'RSI', category: 'oscillator', enabled: false, calcParams: getDefaultCalcParams('RSI') },
  { id: 'KDJ', name: 'Stochastic KDJ', category: 'oscillator', enabled: false, calcParams: getDefaultCalcParams('KDJ') },
  { id: 'OBV', name: 'On Balance Volume', category: 'volume', enabled: false, calcParams: getDefaultCalcParams('OBV') },
];

export const INTERVALS: { value: string; label: string; period: Period }[] = [
  { value: '1m', label: '1m', period: { type: 'minute', span: 1 } },
  { value: '3m', label: '3m', period: { type: 'minute', span: 3 } },
  { value: '5m', label: '5m', period: { type: 'minute', span: 5 } },
  { value: '15m', label: '15m', period: { type: 'minute', span: 15 } },
  { value: '30m', label: '30m', period: { type: 'minute', span: 30 } },
  { value: '1h', label: '1H', period: { type: 'hour', span: 1 } },
  { value: '2h', label: '2H', period: { type: 'hour', span: 2 } },
  { value: '4h', label: '4H', period: { type: 'hour', span: 4 } },
  { value: '6h', label: '6H', period: { type: 'hour', span: 6 } },
  { value: '12h', label: '12H', period: { type: 'hour', span: 12 } },
  { value: '1d', label: '1D', period: { type: 'day', span: 1 } },
  { value: '1w', label: '1W', period: { type: 'week', span: 1 } },
  { value: '1M', label: '1M', period: { type: 'month', span: 1 } },
];

export const PRIMARY_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
export const MORE_INTERVALS = ['3m', '30m', '2h', '6h', '12h', '1w', '1M'];

export const DRAWING_TOOLS: {
  id: string;
  label: string;
  icon:
    | 'segment'
    | 'horizontalStraightLine'
    | 'fibonacciLine'
    | 'parallelStraightLine'
    | 'rayLine'
    | 'straightLine'
    | 'horizontalRayLine'
    | 'verticalStraightLine';
}[] = [
  { id: 'segment', label: 'Trendline', icon: 'segment' },
  { id: 'horizontalStraightLine', label: 'Horizontal Line', icon: 'horizontalStraightLine' },
  { id: 'rayLine', label: 'Ray', icon: 'rayLine' },
  { id: 'straightLine', label: 'Extended Line', icon: 'straightLine' },
  { id: 'horizontalRayLine', label: 'Horizontal Ray', icon: 'horizontalRayLine' },
  { id: 'verticalStraightLine', label: 'Vertical Line', icon: 'verticalStraightLine' },
  { id: 'fibonacciLine', label: 'Fibonacci Retracement', icon: 'fibonacciLine' },
  { id: 'parallelStraightLine', label: 'Parallel Channel', icon: 'parallelStraightLine' },
];

export function periodToInterval(period: Period): string {
  switch (period.type) {
    case 'minute':
      return `${period.span}m`;
    case 'hour':
      return `${period.span}h`;
    case 'day':
      return `${period.span}d`;
    case 'week':
      return `${period.span}w`;
    case 'month':
      return `${period.span}M`;
    default:
      return '1h';
  }
}

export function useTradingChartEngine({
  symbol,
  interval,
  market = 'spot',
  chartType = 'candle_solid',
  initialIndicators = DEFAULT_INDICATORS,
  showCandleTooltip = true,
  signalOverlay,
  callsOverlay,
  focusOverlay,
  onLoadedRangeChange,
  onVisibleRangeChange,
  restoreOverlays = true,
}: TradingChartEngineOptions) {
  const chartRef = useRef<Chart | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [activeDrawingTool, setActiveDrawingTool] = useState<string | null>(null);
  const [indicators, setIndicators] = useState<IndicatorConfig[]>(initialIndicators);
  const initialIndicatorsRef = useRef(initialIndicators);
  const [isLoading, setIsLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [crosshairData, setCrosshairData] = useState<KLineData | null>(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [cssFullscreen, setCssFullscreen] = useState(false);
  const isFullscreen = nativeFullscreen || cssFullscreen;
  const [magnetMode, setMagnetMode] = useState<OverlayMode>('normal');
  const klineUnsubRef = useRef<(() => void) | null>(null);
  const { status: streamStatus, lastMessageAt, retry: retryStream } = useMarketStreamStatus(market);
  const marketRef = useRef(market);
  const barCallbackRef = useRef<((data: KLineData) => void) | null>(null);
  const onLoadedRangeRef = useRef(onLoadedRangeChange);
  const onVisibleRangeRef = useRef(onVisibleRangeChange);
  const lastLoadedToRef = useRef<number | null>(null);
  const callsRef = useRef<ReadonlyMap<number, CallMark>>(NO_CALLS);
  const hoverCallRef = useRef<number | null>(null);
  const callsExtendRef = useRef({ boundary: null as number | null, horizonBars: 0 });
  const [hoverCall, setHoverCall] = useState<CallMark | null>(null);

  const theme = useChartTheme();

  useEffect(() => {
    marketRef.current = market;
    onLoadedRangeRef.current = onLoadedRangeChange;
    onVisibleRangeRef.current = onVisibleRangeChange;
  }, [market, onLoadedRangeChange, onVisibleRangeChange]);

  /** Tells the parent which bars are loaded, from the chart's own data list. */
  const reportLoadedRange = useCallback(() => {
    const list = chartRef.current?.getDataList() ?? [];
    if (list.length === 0) return;
    const range = { from: list[0].timestamp, to: list[list.length - 1].timestamp };
    lastLoadedToRef.current = range.to;
    onLoadedRangeRef.current?.(range);
  }, []);

  const { containerRef, width, height } = useChartResize(chartRef);
  const hasValidDimensions = Boolean(width && height && width > 0 && height > 0);

  const addIndicatorToChart = useCallback((indicator: IndicatorConfig) => {
    if (!chartRef.current) return;

    if (indicator.category === 'overlay') {
      // Stacked: an unstacked create removes every other indicator on the pane.
      chartRef.current.createIndicator(indicator.id, true, { id: 'candle_pane' });
    } else {
      chartRef.current.createIndicator(indicator.id, false);
    }
  }, []);

  const removeIndicatorFromChart = useCallback((indicator: IndicatorConfig) => {
    if (!chartRef.current) return;

    if (indicator.category === 'overlay') {
      chartRef.current.removeIndicator({ paneId: 'candle_pane', name: indicator.id });
    } else {
      chartRef.current.removeIndicator({ name: indicator.id });
    }
  }, []);

  const toggleIndicator = useCallback(
    (indicatorId: string) => {
      const indicator = indicators.find((ind) => ind.id === indicatorId);
      if (!indicator) return;

      if (indicator.enabled) {
        removeIndicatorFromChart(indicator);
      } else {
        addIndicatorToChart(indicator);
      }

      setIndicators((prev) =>
        prev.map((ind) =>
          ind.id === indicatorId ? { ...ind, enabled: !ind.enabled } : ind
        )
      );
    },
    [indicators, addIndicatorToChart, removeIndicatorFromChart]
  );

  const updateIndicatorParams = useCallback(
    (indicatorId: string, params: number[]) => {
      if (!chartRef.current) return;
      chartRef.current.overrideIndicator({ name: indicatorId, calcParams: params });
      setIndicators((prev) =>
        prev.map((ind) =>
          ind.id === indicatorId ? { ...ind, calcParams: params } : ind
        )
      );
    },
    []
  );

  const persistOverlays = useCallback(() => {
    if (!restoreOverlays) return;
    if (!chartRef.current) return;
    const allOverlays = chartRef.current.getOverlays();
    const serialized: SerializedOverlay[] = allOverlays
      .filter((o) => o.points.length > 0)
      .map((o) => ({
        name: o.name,
        points: o.points.map((p) => ({
          ...(p.dataIndex !== undefined && { dataIndex: p.dataIndex }),
          ...(p.timestamp !== undefined && { timestamp: p.timestamp }),
          ...(p.value !== undefined && { value: p.value }),
        })),
      }));
    saveOverlays(symbol, serialized);
  }, [symbol, restoreOverlays]);

  const activateDrawingTool = useCallback(
    (tool: string) => {
      if (!chartRef.current) return;

      if (activeDrawingTool === tool) {
        chartRef.current.removeOverlay();
        setActiveDrawingTool(null);
      } else {
        chartRef.current.createOverlay({
          name: tool,
          mode: magnetMode,
          onDrawEnd: () => {
            persistOverlays();
          },
          onPressedMoveEnd: () => {
            persistOverlays();
          },
        });
        setActiveDrawingTool(tool);
      }
    },
    [activeDrawingTool, magnetMode, persistOverlays]
  );

  const clearDrawings = useCallback(() => {
    chartRef.current?.removeOverlay();
    setActiveDrawingTool(null);
    if (restoreOverlays) {
      clearOverlays(symbol);
    }
  }, [symbol, restoreOverlays]);

  const toggleMagnetMode = useCallback(() => {
    setMagnetMode((prev) => (prev === 'normal' ? 'weak_magnet' : 'normal'));
  }, []);

  // Initialize chart with DataLoader and theme styles
  useEffect(() => {
    if (!containerRef.current || !hasValidDimensions) return;

    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const container = containerRef.current;
    setIndicatorTheme(theme);
    chartRef.current = init(container, {
      styles: buildChartStyles(theme, { showCandleTooltip }),
      locale: 'en-US',
      timezone: 'Etc/UTC',
    });

    chartRef.current!.setDataLoader({
      getBars: async (params: DataLoaderGetBarsParams) => {
        // KlineCharts names directions by the data list: 'forward' prepends,
        // so it is the OLDER page asked for when the user scrolls to the left
        // edge; 'backward' would append newer bars, which do not exist.
        if (params.type === 'forward') {
          const firstOpen = params.timestamp;
          if (firstOpen === null) {
            params.callback([], { forward: false });
            return;
          }
          try {
            const query = new URLSearchParams({
              symbol: params.symbol.ticker,
              interval: periodToInterval(params.period),
              limit: String(HISTORY_PAGE_BARS),
              endTime: String(firstOpen - 1),
            });
            if (marketRef.current === 'perp') {
              query.set('market', 'perp');
            }
            const res = await fetch(`/api/prices/history?${query}`);
            if (!res.ok) throw new Error('Failed to fetch');
            const data = await res.json();
            // The user switched symbol or interval while this page was in flight:
            // its bars belong to the old series, and the new one is loading.
            if (isStalePage(chartRef.current, params)) return;
            const bars: KLineData[] = data.map(
              (d: {
                timestamp: number;
                open: number;
                high: number;
                low: number;
                close: number;
                volume: number;
                takerBuyVolume?: number;
              }) => ({
                timestamp: d.timestamp,
                open: d.open,
                high: d.high,
                low: d.low,
                close: d.close,
                volume: d.volume,
                ...(typeof d.takerBuyVolume === 'number' && Number.isFinite(d.takerBuyVolume)
                  ? { takerBuyVolume: d.takerBuyVolume }
                  : {}),
              })
            );
            // A short page means the symbol's history starts here.
            params.callback(bars, { forward: bars.length === HISTORY_PAGE_BARS });
            reportLoadedRange();
          } catch {
            if (isStalePage(chartRef.current, params)) return;
            // Leave paging on: the next scroll to the edge retries.
            params.callback([], { forward: true });
          }
          return;
        }
        if (params.type !== 'init') {
          params.callback([], false);
          return;
        }

        setIsLoading(true);
        try {
          const sym = params.symbol.ticker;
          const intv = periodToInterval(params.period);
          const queryParams = new URLSearchParams({
            symbol: sym,
            interval: intv,
            limit: '500',
          });
          if (marketRef.current === 'perp') {
            queryParams.set('market', 'perp');
          }
          const res = await fetch(`/api/prices/history?${queryParams}`);
          if (!res.ok) throw new Error('Failed to fetch');
          const data = await res.json();
          const bars: KLineData[] = data.map(
            (d: {
              timestamp: number;
              open: number;
              high: number;
              low: number;
              close: number;
              volume: number;
              takerBuyVolume?: number;
            }) => ({
              timestamp: d.timestamp,
              open: d.open,
              high: d.high,
              low: d.low,
              close: d.close,
              volume: d.volume,
              ...(typeof d.takerBuyVolume === 'number' && Number.isFinite(d.takerBuyVolume)
                ? { takerBuyVolume: d.takerBuyVolume }
                : {}),
            })
          );
          // Older pages load on scroll; nothing newer than the live bar exists.
          params.callback(bars, { forward: bars.length > 0, backward: false });
          reportLoadedRange();
          setHistoryError(false);
        } catch {
          setHistoryError(true);
          params.callback([], false);
        } finally {
          setIsLoading(false);
        }
      },
      subscribeBar: (params: DataLoaderSubscribeBarParams) => {
        barCallbackRef.current = params.callback;
        const intv = periodToInterval(params.period);
        const stream = klineStream(params.symbol.ticker, intv);
        klineUnsubRef.current?.();
        klineUnsubRef.current = getStreamClient(marketRef.current).subscribe([stream], (frame) => {
          try {
            if (frame.stream !== stream) return;
            const k = (frame.data as { k?: BinanceKline } | null)?.k;
            if (!k) return;
            if (barCallbackRef.current) {
              const liveTakerBuyVolume = parseFloat(k.V);
              barCallbackRef.current({
                timestamp: k.t,
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: parseFloat(k.c),
                volume: parseFloat(k.v),
                ...(Number.isFinite(liveTakerBuyVolume)
                  ? { takerBuyVolume: liveTakerBuyVolume }
                  : {}),
              });
              if (lastLoadedToRef.current !== null && Number(k.t) > lastLoadedToRef.current) {
                reportLoadedRange();
              }
            }
            // Market data for the provisional-signal overlay (never a score).
            const bar = {
              openTime: Number(k.t),
              open: parseFloat(k.o),
              high: parseFloat(k.h),
              low: parseFloat(k.l),
              close: parseFloat(k.c),
              volume: parseFloat(k.v),
              takerBuyVolume: parseFloat(k.V),
            };
            if (Object.values(bar).every(Number.isFinite)) {
              useFormingBarStore.getState().push({
                symbol: params.symbol.ticker.toUpperCase(),
                interval: intv,
                bar,
                closed: k.x === true,
                receivedAt: Date.now(),
              });
            }
          } catch {
            // ignore frame errors
          }
        });
      },
      unsubscribeBar: () => {
        barCallbackRef.current = null;
        useFormingBarStore.getState().reset();
        klineUnsubRef.current?.();
        klineUnsubRef.current = null;
      },
    });

    // Initialize default indicators inline (avoids external callback dependency)
    if (!focusOverlay) {
      initialIndicatorsRef.current.forEach((ind) => {
        if (ind.enabled && chartRef.current) {
          if (ind.category === 'overlay') {
            chartRef.current.createIndicator(ind.id, true, { id: 'candle_pane' });
          } else {
            chartRef.current.createIndicator(ind.id, false);
          }
        }
      });
    }

    // Set initial symbol/period so getBars fires immediately.
    const chart = chartRef.current!;
    chart.setSymbol({ ticker: symbol, pricePrecision: 2, volumePrecision: 2 });
    const initInterval = INTERVALS.find((i) => i.value === interval);
    if (initInterval) {
      chart.setPeriod(initInterval.period);
    }

    return () => {
      klineUnsubRef.current?.();
      klineUnsubRef.current = null;
      if (container && chartRef.current) {
        dispose(container);
        chartRef.current = null;
      }
    };
    // symbol and interval are intentionally included so the chart re-initializes
    // if they change before hasValidDimensions becomes true (unlikely but safe).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasValidDimensions, containerRef]);

  // Update styles and redraw when theme changes
  useEffect(() => {
    if (!chartRef.current) return;
    setIndicatorTheme(theme);
    chartRef.current.setStyles(buildChartStyles(theme, { showCandleTooltip }));
    if (chartType) {
      chartRef.current.setStyles({ candle: { type: chartType } });
    }
    chartRef.current.resize();
  }, [theme, chartType, showCandleTooltip]);

  const overlayVisible = signalOverlay?.visible ?? false;
  const overlayRecorded = signalOverlay?.recorded;
  const overlayProvisional = signalOverlay?.provisional ?? null;
  const overlayState = signalOverlay?.state ?? null;
  const overlayRescored = signalOverlay?.rescored;

  // The signal score pane lives and dies with the flag; it is not a saved indicator.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !overlayVisible) return;
    ensureSignalScoreIndicatorRegistered();
    chart.createIndicator(SIGNAL_SCORE_INDICATOR, false, { id: SIGNAL_SCORE_PANE_ID, height: 140 });
    return () => {
      // After dispose chartRef is null, and the pane went with the chart.
      chartRef.current?.removeIndicator({ paneId: SIGNAL_SCORE_PANE_ID, name: SIGNAL_SCORE_INDICATOR });
    };
  }, [overlayVisible, hasValidDimensions]);

  // overrideIndicator recalculates only for a NEW calc, so every change passes one.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !overlayVisible) return;
    chart.overrideIndicator({
      name: SIGNAL_SCORE_INDICATOR,
      calc: makeSignalScoreCalc({
        recorded: overlayRecorded ?? new Map(),
        provisional: overlayProvisional,
        state: overlayState,
        rescored: overlayRescored,
      }),
    });
  }, [overlayVisible, hasValidDimensions, overlayRecorded, overlayProvisional, overlayState, overlayRescored]);

  const callsVisible = callsOverlay?.visible ?? false;
  const calls = callsOverlay?.calls ?? NO_CALLS;
  const callsBoundary = callsOverlay?.boundary ?? null;
  const callsHorizon = callsOverlay?.horizonBars ?? 0;
  const callsCost = callsOverlay?.costPercent ?? 0;

  // Past calls stack on the price pane beside MA and the other overlays.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !callsVisible) return;
    ensureSignalCallsIndicatorRegistered();
    chart.createIndicator(SIGNAL_CALLS_INDICATOR, true, { id: 'candle_pane' });
    return () => {
      hoverCallRef.current = null;
      setHoverCall(null);
      chartRef.current?.removeIndicator({ paneId: 'candle_pane', name: SIGNAL_CALLS_INDICATOR });
    };
  }, [callsVisible, hasValidDimensions]);

  useEffect(() => {
    callsRef.current = callsVisible ? calls : NO_CALLS;
    callsExtendRef.current = { boundary: callsBoundary, horizonBars: callsHorizon };
    const chart = chartRef.current;
    if (!chart || !callsVisible) return;
    chart.overrideIndicator({
      name: SIGNAL_CALLS_INDICATOR,
      calc: makeSignalCallsCalc({ calls }),
      extendData: { boundary: callsBoundary, hover: hoverCallRef.current, horizonBars: callsHorizon },
    });
  }, [callsVisible, hasValidDimensions, calls, callsBoundary, callsHorizon]);

  const focusActive = Boolean(focusOverlay);
  const focusIntervalMs = focusOverlay?.intervalMs;
  const focusShowInternal = focusOverlay?.showInternal ?? false;
  const focusShowSma = focusOverlay?.showSma ?? false;
  const focusShowMacd = focusOverlay?.showMacd ?? false;
  const focusPriorDay = focusOverlay?.priorDay ?? null;
  const focusLabMarks = focusOverlay?.labMarks;

  // Focus preset indicators: STRUCTURE on candle_pane (stacked), DELTA_VOL and CVD in their own panes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !focusActive) return;
    ensureFocusIndicatorsRegistered();
    chart.createIndicator(STRUCTURE_INDICATOR, true, { id: 'candle_pane' });
    chart.createIndicator(DELTA_VOL_INDICATOR, false, { id: DELTA_VOL_PANE_ID, height: DELTA_VOL_PANE_HEIGHT });
    chart.createIndicator(CVD_INDICATOR, false, { id: CVD_PANE_ID, height: CVD_PANE_HEIGHT });
    return () => {
      chartRef.current?.removeIndicator({ paneId: 'candle_pane', name: STRUCTURE_INDICATOR });
      chartRef.current?.removeIndicator({ paneId: DELTA_VOL_PANE_ID, name: DELTA_VOL_INDICATOR });
      chartRef.current?.removeIndicator({ paneId: CVD_PANE_ID, name: CVD_INDICATOR });
    };
  }, [focusActive, hasValidDimensions]);

  // Recalculate structure when interval, internal toggle, or prior-day levels change
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !focusActive || focusIntervalMs === undefined) return;
    chart.overrideIndicator({
      name: STRUCTURE_INDICATOR,
      calc: makeStructureCalc({
        intervalMs: focusIntervalMs,
        showInternal: focusShowInternal,
      }),
      extendData: { priorDay: focusPriorDay, labMarks: focusLabMarks },
    });
  }, [focusActive, hasValidDimensions, focusIntervalMs, focusShowInternal, focusPriorDay, focusLabMarks]);

  // SMA toggle for focus preset: 50 MA stacked on candle_pane
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !focusActive || !focusShowSma) return;
    chart.createIndicator({ name: 'MA', calcParams: [50] }, true, { id: 'candle_pane' });
    return () => {
      chartRef.current?.removeIndicator({ paneId: 'candle_pane', name: 'MA' });
    };
  }, [focusActive, hasValidDimensions, focusShowSma]);

  // MACD toggle for focus preset: MACD in its own pane
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !focusActive || !focusShowMacd) return;
    chart.createIndicator('MACD', false);
    return () => {
      chartRef.current?.removeIndicator({ name: 'MACD' });
    };
  }, [focusActive, hasValidDimensions, focusShowMacd]);

  // Report the visible window, debounced: scrolling fires this every frame.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const current = chartRef.current;
        if (!current) return;
        const list = current.getDataList();
        if (list.length === 0) return;
        const { realFrom, realTo } = current.getVisibleRange();
        const first = list[Math.max(0, Math.min(list.length - 1, Math.floor(realFrom)))];
        const last = list[Math.max(0, Math.min(list.length - 1, Math.ceil(realTo) - 1))];
        onVisibleRangeRef.current?.({ from: first.timestamp, to: last.timestamp });
      }, VISIBLE_RANGE_DEBOUNCE_MS);
    };
    chart.subscribeAction('onVisibleRangeChange', handle);
    return () => {
      if (timer) clearTimeout(timer);
      chart.unsubscribeAction('onVisibleRangeChange', handle);
    };
  }, [hasValidDimensions]);

  // Update symbol and period when props change
  useEffect(() => {
    marketRef.current = market;
    if (!chartRef.current) return;
    const intv = INTERVALS.find((i) => i.value === interval);
    chartRef.current.setSymbol({ ticker: symbol, pricePrecision: 2, volumePrecision: 2 });
    if (intv) {
      chartRef.current.setPeriod(intv.period);
    }
  }, [symbol, interval, market]);

  // Update chart type when prop changes
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.setStyles({ candle: { type: chartType } });
  }, [chartType]);

  // Subscribe to crosshair changes for OHLCV legend
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = chartRef.current;

    const handleCrosshairChange = (data: unknown) => {
      const crosshair = data as Crosshair;
      setCrosshairData(crosshair?.kLineData ?? null);
      // The call under the crosshair draws its judged span; a redraw, not a recalculation.
      const ts = barAtCrosshair(chart, crosshair)?.timestamp;
      const hover = typeof ts === 'number' && callsRef.current.has(ts) ? ts : null;
      if (hover !== hoverCallRef.current) {
        hoverCallRef.current = hover;
        setHoverCall(hover === null ? null : (callsRef.current.get(hover) ?? null));
        if (callsRef.current.size > 0) {
          chart.overrideIndicator({
            name: SIGNAL_CALLS_INDICATOR,
            extendData: { ...callsExtendRef.current, hover },
          });
        }
      }
    };

    chart.subscribeAction('onCrosshairChange', handleCrosshairChange);
    return () => {
      chart.unsubscribeAction('onCrosshairChange', handleCrosshairChange);
    };
  }, [hasValidDimensions]);

  // Load saved overlays when symbol changes
  useEffect(() => {
    if (!restoreOverlays) return;
    if (!chartRef.current) return;
    const chart = chartRef.current;
    const saved = loadOverlays(symbol);
    for (const overlay of saved) {
      chart.createOverlay({
        name: overlay.name,
        points: overlay.points,
        mode: magnetMode,
        onDrawEnd: () => {
          persistOverlays();
        },
        onPressedMoveEnd: () => {
          persistOverlays();
        },
        onRemoved: () => {
          persistOverlays();
        },
      });
    }
  }, [symbol, hasValidDimensions, magnetMode, persistOverlays, restoreOverlays]);

  // Track fullscreen changes (e.g. Escape key exits natively)
  useEffect(() => {
    function handleFullscreenChange() {
      setNativeFullscreen(document.fullscreenElement === wrapperRef.current);
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!cssFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCssFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cssFullscreen]);

  const toggleFullscreen = useCallback(async () => {
    const el = wrapperRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      return;
    }
    if (cssFullscreen) {
      setCssFullscreen(false);
      return;
    }
    if (document.fullscreenEnabled && typeof el.requestFullscreen === 'function') {
      try {
        await el.requestFullscreen();
        return;
      } catch {
        // rejected (policy, iPad Safari): fall back to the CSS overlay
      }
    }
    setCssFullscreen(true);
  }, [cssFullscreen]);

  const handleRefresh = () => {
    if (!chartRef.current) return;
    setHistoryError(false);
    setIsLoading(true);
    chartRef.current.resetData();
  };

  const overlayIndicators = useMemo(
    () => indicators.filter((ind) => ind.category === 'overlay'),
    [indicators]
  );
  const oscillatorIndicators = useMemo(
    () => indicators.filter((ind) => ind.category === 'oscillator'),
    [indicators]
  );
  const volumeIndicators = useMemo(
    () => indicators.filter((ind) => ind.category === 'volume'),
    [indicators]
  );

  return {
    chartRef,
    containerRef,
    wrapperRef,
    isLoading,
    historyError,
    crosshairData,
    hoverCall,
    indicators,
    toggleIndicator,
    updateIndicatorParams,
    activeDrawingTool,
    activateDrawingTool,
    clearDrawings,
    magnetMode,
    toggleMagnetMode,
    isFullscreen,
    cssFullscreen,
    toggleFullscreen,
    handleRefresh,
    streamStatus,
    lastMessageAt,
    retryStream,
    overlayIndicators,
    oscillatorIndicators,
    volumeIndicators,
    callsVisible,
    callsHorizon,
    callsCost,
  };
}
