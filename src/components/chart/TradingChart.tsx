'use client';

import type { CandleType } from 'klinecharts';
import {
  Activity,
  ArrowRight,
  BarChart2,
  ChevronDown,
  Magnet,
  Maximize2,
  Minimize2,
  MoveRight,
  TrendingUp,
  Minus,
  MoveVertical,
  Move,
  Slash,
  Trash2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { IndicatorSettings } from './IndicatorSettings';
import { ChartLegend } from './ChartLegend';
import {
  CALL_COLORS,
  describeCall,
} from './signal-calls-indicator';
import { Mark } from './track-record/CallLegend';
import { StreamStatusBadge } from '@/components/market/StreamStatusBadge';
import {
  useTradingChartEngine,
  barAtCrosshair,
  isStalePage,
  periodToInterval,
  HISTORY_PAGE_BARS,
  CHART_TYPES,
  DEFAULT_INDICATORS,
  INTERVALS,
  PRIMARY_INTERVALS,
  MORE_INTERVALS,
  DRAWING_TOOLS,
  type IndicatorConfig,
  type TimeRange,
  type SignalOverlay,
  type CallsOverlay,
  type TradingChartEngineOptions,
} from './useTradingChartEngine';

export {
  barAtCrosshair,
  isStalePage,
  periodToInterval,
  HISTORY_PAGE_BARS,
  CHART_TYPES,
  DEFAULT_INDICATORS,
  INTERVALS,
  PRIMARY_INTERVALS,
  MORE_INTERVALS,
  DRAWING_TOOLS,
  type IndicatorConfig,
  type TimeRange,
  type SignalOverlay,
  type CallsOverlay,
};

export interface TradingChartProps extends TradingChartEngineOptions {
  intervalOptions?: string[];
  onIntervalChange?: (interval: string) => void;
  onChartTypeChange?: (type: CandleType) => void;
}

function DrawingToolIcon({ icon }: { icon: string }) {
  switch (icon) {
    case 'segment': return <TrendingUp className="h-4 w-4" />;
    case 'horizontalStraightLine': return <Minus className="h-4 w-4" />;
    case 'rayLine': return <ArrowRight className="h-4 w-4" />;
    case 'straightLine': return <Slash className="h-4 w-4" />;
    case 'horizontalRayLine': return <MoveRight className="h-4 w-4" />;
    case 'verticalStraightLine': return <MoveVertical className="h-4 w-4" />;
    case 'fibonacciLine': return <Activity className="h-4 w-4" />;
    case 'parallelStraightLine': return <Move className="h-4 w-4" />;
    default: return <TrendingUp className="h-4 w-4" />;
  }
}

export function TradingChart({
  symbol,
  interval,
  market = 'spot',
  chartType = 'candle_solid',
  intervalOptions,
  onIntervalChange,
  onChartTypeChange,
  signalOverlay,
  callsOverlay,
  focusOverlay,
  onLoadedRangeChange,
  onVisibleRangeChange,
}: TradingChartProps) {
  const primaryList = intervalOptions
    ? PRIMARY_INTERVALS.filter((int) => intervalOptions.includes(int))
    : PRIMARY_INTERVALS;
  const moreList = intervalOptions
    ? MORE_INTERVALS.filter((int) => intervalOptions.includes(int))
    : MORE_INTERVALS;

  const {
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
  } = useTradingChartEngine({
    symbol,
    interval,
    market,
    chartType,
    signalOverlay,
    callsOverlay,
    focusOverlay,
    onLoadedRangeChange,
    onVisibleRangeChange,
  });

  return (
    <div
      ref={wrapperRef}
      className={`flex h-full flex-col overflow-hidden rounded-sm border border-border bg-card shadow-sm ${
        cssFullscreen ? 'fixed inset-0 z-50 bg-background' : ''
      }`}
    >
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card p-2">
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 overflow-x-auto scrollbar-hide">
          {primaryList.length > 0 && (
            <Tabs value={primaryList.includes(interval) ? interval : ''} onValueChange={(val) => onIntervalChange?.(val)}>
              <TabsList className="h-auto bg-muted/50 sm:h-8">
                {INTERVALS.filter((int) => primaryList.includes(int.value)).map((int) => (
                  <TabsTrigger
                    key={int.value}
                    value={int.value}
                    className="min-h-11 min-w-11 px-2 text-xs sm:h-7 sm:min-h-7 sm:min-w-0 data-[state=active]:bg-background data-[state=active]:text-primary"
                  >
                    {int.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}

          {moreList.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant={moreList.includes(interval) ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-8 gap-1 text-xs"
                >
                  {moreList.includes(interval)
                    ? INTERVALS.find((i) => i.value === interval)?.label
                    : 'More'}
                  <ChevronDown className="h-3.5 w-3.5 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-24">
                {INTERVALS.filter((int) => moreList.includes(int.value)).map((int) => (
                  <DropdownMenuItem
                    key={int.value}
                    className={interval === int.value ? 'bg-accent' : ''}
                    onSelect={() => onIntervalChange?.(int.value)}
                  >
                    {int.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <Separator orientation="vertical" className="h-6" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 min-h-11 min-w-11 gap-1 text-xs sm:min-h-0 sm:min-w-0"
              >
                <BarChart2 className="h-3.5 w-3.5" />
                {CHART_TYPES.find((t) => t.value === chartType)?.label ?? 'Candles'}
                <ChevronDown className="h-3.5 w-3.5 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-28">
              {CHART_TYPES.map((t) => (
                <DropdownMenuItem
                  key={t.value}
                  className={chartType === t.value ? 'bg-accent' : ''}
                  onSelect={() => onChartTypeChange?.(t.value)}
                >
                  {t.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {!focusOverlay && (
            <>
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

              {indicators.filter((ind) => ind.enabled).map((ind) => (
                <div key={ind.id} className="flex items-center gap-0.5">
                  <span className="text-xs text-muted-foreground">
                    {ind.id}({ind.calcParams.join(',')})
                  </span>
                  <IndicatorSettings
                    indicatorId={ind.id}
                    indicatorName={ind.name}
                    calcParams={ind.calcParams}
                    onParamsChange={updateIndicatorParams}
                  />
                </div>
              ))}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <StreamStatusBadge
            status={streamStatus}
            lastMessageAt={lastMessageAt}
            onRetry={retryStream}
          />

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
            onClick={handleRefresh}
            disabled={isLoading}
            aria-label="Refresh chart"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Drawing Toolbar */}
      <div className="flex flex-wrap sm:flex-nowrap items-center gap-1 overflow-x-auto border-b border-border bg-muted/20 p-1">
        <TooltipProvider>
          {DRAWING_TOOLS.map((tool) => (
            <Tooltip key={tool.id}>
              <TooltipTrigger asChild>
                <Button
                  variant={activeDrawingTool === tool.id ? 'secondary' : 'ghost'}
                  size="sm"
                  className="min-h-11 min-w-11 p-0 sm:h-7 sm:w-7 sm:min-h-7 sm:min-w-7"
                  onClick={() => activateDrawingTool(tool.id)}
                  aria-label={tool.label}
                >
                  <DrawingToolIcon icon={tool.icon} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{tool.label}</TooltipContent>
            </Tooltip>
          ))}

          <Separator orientation="vertical" className="mx-1 h-4" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={magnetMode === 'weak_magnet' ? 'secondary' : 'ghost'}
                size="sm"
                className="min-h-11 min-w-11 p-0 sm:h-7 sm:w-7 sm:min-h-7 sm:min-w-7"
                onClick={toggleMagnetMode}
                aria-label={magnetMode === 'weak_magnet' ? 'Disable magnet mode' : 'Enable magnet mode'}
              >
                <Magnet className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{magnetMode === 'weak_magnet' ? 'Magnet: On' : 'Magnet: Off'}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 min-w-11 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive sm:h-7 sm:w-7 sm:min-h-7 sm:min-w-7"
                onClick={clearDrawings}
                aria-label="Clear drawings"
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
        <ChartLegend symbol={symbol} kLineData={crosshairData} />

        {historyError && !isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <div
              role="alert"
              className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-4 shadow-sm"
            >
              <span className="text-sm text-muted-foreground">Could not load price history.</span>
              <Button variant="outline" size="sm" onClick={handleRefresh}>
                Retry
              </Button>
            </div>
          </div>
        )}

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

      {callsVisible && (
        <div
          data-testid="call-detail"
          className="flex min-h-8 items-center gap-1.5 border-t border-border bg-card px-2 py-1 text-xs text-muted-foreground"
        >
          {hoverCall ? (
            <>
              <Mark up={hoverCall.dir === 1} color={CALL_COLORS[hoverCall.outcome]} hollow={hoverCall.outcome === 'pending'} />
              <span className="text-foreground">{describeCall(hoverCall, callsHorizon, callsCost)}</span>
            </>
          ) : (
            'Hover or touch a call mark to see its score and how it ended.'
          )}
        </div>
      )}
    </div>
  );
}
