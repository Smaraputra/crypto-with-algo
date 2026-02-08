'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  init,
  dispose,
  type Chart,
  type DataLoaderGetBarsParams,
  type DataLoaderSubscribeBarParams,
  type KLineData,
  type Period,
} from 'klinecharts';
import { useChartResize } from '@/hooks/useChartResize';
import {
  Activity,
  ChevronDown,
  TrendingUp,
  Minus,
  Move,
  Trash2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';

const DEFAULT_WS_BASE = 'wss://stream.binance.com:9443';

function getBinanceWsBase(): string {
  return process.env.NEXT_PUBLIC_BINANCE_WS_URL || DEFAULT_WS_BASE;
}

export interface TradingChartProps {
  symbol: string;
  interval: string;
  onIntervalChange?: (interval: string) => void;
}

export interface IndicatorConfig {
  id: string;
  name: string;
  category: 'overlay' | 'oscillator' | 'volume';
  enabled: boolean;
  paneId?: string;
}

export const DEFAULT_INDICATORS: IndicatorConfig[] = [
  { id: 'MA', name: 'Moving Average', category: 'overlay', enabled: true },
  { id: 'EMA', name: 'EMA', category: 'overlay', enabled: false },
  { id: 'BOLL', name: 'Bollinger Bands', category: 'overlay', enabled: false },
  { id: 'SAR', name: 'Parabolic SAR', category: 'overlay', enabled: false },
  { id: 'VOL', name: 'Volume', category: 'volume', enabled: true },
  { id: 'MACD', name: 'MACD', category: 'oscillator', enabled: false },
  { id: 'RSI', name: 'RSI', category: 'oscillator', enabled: false },
  { id: 'KDJ', name: 'Stochastic KDJ', category: 'oscillator', enabled: false },
  { id: 'OBV', name: 'On Balance Volume', category: 'volume', enabled: false },
];

export const INTERVALS: { value: string; label: string; period: Period }[] = [
  { value: '1m', label: '1m', period: { type: 'minute', span: 1 } },
  { value: '5m', label: '5m', period: { type: 'minute', span: 5 } },
  { value: '15m', label: '15m', period: { type: 'minute', span: 15 } },
  { value: '1h', label: '1H', period: { type: 'hour', span: 1 } },
  { value: '4h', label: '4H', period: { type: 'hour', span: 4 } },
  { value: '1d', label: '1D', period: { type: 'day', span: 1 } },
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

export function TradingChart({ symbol, interval, onIntervalChange }: TradingChartProps) {
  const chartRef = useRef<Chart | null>(null);
  const [activeDrawingTool, setActiveDrawingTool] = useState<string | null>(null);
  const [indicators, setIndicators] = useState<IndicatorConfig[]>(DEFAULT_INDICATORS);
  const [isLoading, setIsLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const barCallbackRef = useRef<((data: KLineData) => void) | null>(null);

  const { containerRef, width, height } = useChartResize(chartRef);
  const hasValidDimensions = Boolean(width && height && width > 0 && height > 0);

  const addIndicatorToChart = useCallback((indicator: IndicatorConfig) => {
    if (!chartRef.current) return;

    if (indicator.category === 'overlay') {
      chartRef.current.createIndicator(indicator.id, false, { id: 'candle_pane' });
    } else {
      const paneId = chartRef.current.createIndicator(indicator.id, false);
      setIndicators((prev) =>
        prev.map((ind) =>
          ind.id === indicator.id ? { ...ind, paneId: paneId || undefined } : ind
        )
      );
    }
  }, []);

  const removeIndicatorFromChart = useCallback((indicator: IndicatorConfig) => {
    if (!chartRef.current) return;

    if (indicator.category === 'overlay') {
      chartRef.current.removeIndicator({ paneId: 'candle_pane', name: indicator.id });
    } else if (indicator.paneId) {
      chartRef.current.removeIndicator({ paneId: indicator.paneId, name: indicator.id });
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

  // Initialize chart with DataLoader
  useEffect(() => {
    if (!containerRef.current || !hasValidDimensions) return;

    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const container = containerRef.current;
    chartRef.current = init(container, {
      styles: {
        grid: {
          show: true,
          horizontal: { color: '#1e2329' },
          vertical: { color: '#1e2329' },
        },
        candle: {
          type: 'candle_solid',
          priceMark: {
            show: true,
            high: { show: true, color: '#0ecb81' },
            low: { show: true, color: '#f6465d' },
            last: { show: true },
          },
          bar: {
            upColor: '#0ecb81',
            downColor: '#f6465d',
            noChangeColor: '#71717a',
            upBorderColor: '#0ecb81',
            downBorderColor: '#f6465d',
            noChangeBorderColor: '#71717a',
          },
        },
        indicator: {
          lastValueMark: { show: true },
        },
        xAxis: {
          axisLine: { color: '#1e2329' },
          tickLine: { color: '#1e2329' },
          tickText: { color: '#848e9c' },
        },
        yAxis: {
          axisLine: { color: '#1e2329' },
          tickLine: { color: '#1e2329' },
          tickText: { color: '#848e9c' },
        },
        crosshair: {
          show: true,
          horizontal: {
            line: { color: '#D4AF37', style: 'dashed' },
          },
          vertical: {
            line: { color: '#D4AF37', style: 'dashed' },
          },
        },
        separator: {
          color: '#1e2329',
        },
      },
      locale: 'en-US',
      timezone: 'Etc/UTC',
    });

    chartRef.current!.setDataLoader({
      getBars: async (params: DataLoaderGetBarsParams) => {
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
          const res = await fetch(`/api/prices/history?${queryParams}`);
          if (!res.ok) throw new Error('Failed to fetch');
          const data = await res.json();
          const bars: KLineData[] = data.map((d: { timestamp: number; open: number; high: number; low: number; close: number; volume: number }) => ({
            timestamp: d.timestamp,
            open: d.open,
            high: d.high,
            low: d.low,
            close: d.close,
            volume: d.volume,
          }));
          params.callback(bars, false);
        } catch {
          params.callback([], false);
        } finally {
          setIsLoading(false);
        }
      },
      subscribeBar: (params: DataLoaderSubscribeBarParams) => {
        barCallbackRef.current = params.callback;
        const sym = params.symbol.ticker.toLowerCase();
        const intv = periodToInterval(params.period);
        const wsBase = getBinanceWsBase();
        const url = `${wsBase}/ws/${sym}@kline_${intv}`;

        if (wsRef.current) {
          wsRef.current.close();
        }

        const ws = new WebSocket(url);
        ws.onopen = () => setWsConnected(true);
        ws.onclose = () => setWsConnected(false);
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            const k = msg.k;
            if (k && barCallbackRef.current) {
              barCallbackRef.current({
                timestamp: k.t,
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: parseFloat(k.c),
                volume: parseFloat(k.v),
              });
            }
          } catch {
            // ignore parse errors
          }
        };
        wsRef.current = ws;
      },
      unsubscribeBar: () => {
        barCallbackRef.current = null;
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
        setWsConnected(false);
      },
    });

    // Initialize default indicators inline (avoids external callback dependency)
    DEFAULT_INDICATORS.forEach((ind) => {
      if (ind.enabled && chartRef.current) {
        if (ind.category === 'overlay') {
          chartRef.current.createIndicator(ind.id, false, { id: 'candle_pane' });
        } else {
          chartRef.current.createIndicator(ind.id, false);
        }
      }
    });

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (container && chartRef.current) {
        dispose(container);
        chartRef.current = null;
      }
    };
  }, [hasValidDimensions, containerRef]);

  // Update symbol and period when props change
  useEffect(() => {
    if (!chartRef.current) return;
    const intv = INTERVALS.find((i) => i.value === interval);
    chartRef.current.setSymbol({ ticker: symbol, pricePrecision: 2, volumePrecision: 2 });
    if (intv) {
      chartRef.current.setPeriod(intv.period);
    }
  }, [symbol, interval]);

  const activateDrawingTool = (tool: string) => {
    if (!chartRef.current) return;

    if (activeDrawingTool === tool) {
      chartRef.current.removeOverlay();
      setActiveDrawingTool(null);
    } else {
      chartRef.current.createOverlay(tool);
      setActiveDrawingTool(tool);
    }
  };

  const clearDrawings = () => {
    chartRef.current?.removeOverlay();
    setActiveDrawingTool(null);
  };

  const handleRefresh = () => {
    if (!chartRef.current) return;
    setIsLoading(true);
    chartRef.current.resetData();
  };

  const overlayIndicators = indicators.filter((ind) => ind.category === 'overlay');
  const oscillatorIndicators = indicators.filter((ind) => ind.category === 'oscillator');
  const volumeIndicators = indicators.filter((ind) => ind.category === 'volume');

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-sm border border-border bg-card shadow-sm">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card p-2">
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
          <Tabs defaultValue={interval} onValueChange={(val) => onIntervalChange?.(val)}>
            <TabsList className="h-8 bg-muted/50">
              {INTERVALS.map((int) => (
                <TabsTrigger
                  key={int.value}
                  value={int.value}
                  className="h-7 px-2 text-xs data-[state=active]:bg-background data-[state=active]:text-primary"
                >
                  {int.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <Separator orientation="vertical" className="h-6" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs">
                <Activity className="h-3.5 w-3.5" />
                Indicators
                <ChevronDown className="h-3.5 w-3.5 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Overlays</DropdownMenuLabel>
              {overlayIndicators.map((ind) => (
                <DropdownMenuCheckboxItem
                  key={ind.id}
                  checked={ind.enabled}
                  onCheckedChange={() => toggleIndicator(ind.id)}
                >
                  {ind.name}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Oscillators</DropdownMenuLabel>
              {oscillatorIndicators.map((ind) => (
                <DropdownMenuCheckboxItem
                  key={ind.id}
                  checked={ind.enabled}
                  onCheckedChange={() => toggleIndicator(ind.id)}
                >
                  {ind.name}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Volume</DropdownMenuLabel>
              {volumeIndicators.map((ind) => (
                <DropdownMenuCheckboxItem
                  key={ind.id}
                  checked={ind.enabled}
                  onCheckedChange={() => toggleIndicator(ind.id)}
                >
                  {ind.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs border ${
                    wsConnected
                      ? 'border-bullish/30 bg-bullish/10 text-bullish'
                      : 'border-accent/30 bg-accent/10 text-accent'
                  }`}
                >
                  <div
                    className={`h-1.5 w-1.5 rounded-full ${
                      wsConnected ? 'bg-bullish animate-pulse' : 'bg-accent'
                    }`}
                  />
                  <span className="hidden font-medium sm:inline">
                    {wsConnected ? 'Live' : 'Connecting'}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">WebSocket connection status</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleRefresh}
            disabled={isLoading}
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Drawing Toolbar */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-muted/20 p-1">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={activeDrawingTool === 'segment' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => activateDrawingTool('segment')}
              >
                <TrendingUp className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Trendline</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={activeDrawingTool === 'horizontalStraightLine' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => activateDrawingTool('horizontalStraightLine')}
              >
                <Minus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Horizontal Line</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={activeDrawingTool === 'fibonacciLine' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => activateDrawingTool('fibonacciLine')}
              >
                <Activity className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Fibonacci Retracement</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={activeDrawingTool === 'parallelStraightLine' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => activateDrawingTool('parallelStraightLine')}
              >
                <Move className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Parallel Channel</TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="mx-1 h-4" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={clearDrawings}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear Drawings</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Chart Area */}
      <div className="relative min-h-0 flex-1 bg-background">
        <div ref={containerRef} className="absolute inset-0 h-full w-full" />

        {isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
            <div className="flex flex-col items-center gap-3">
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm font-medium text-muted-foreground">
                Loading market data...
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
