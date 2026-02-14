'use client';

import { useState } from 'react';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { FuturesPanel } from '@/components/signals/FuturesPanel';
import { SignalBreakdown } from '@/components/signals/SignalBreakdown';
import { SignalGauge } from '@/components/signals/SignalGauge';
import { StyleTabs } from '@/components/signals/StyleTabs';
import { AutoUpdateStatus } from '@/components/signals/AutoUpdateStatus';
import { SignalTimeline } from '@/components/signals/SignalTimeline';
import { MultiStyleOverview } from '@/components/signals/MultiStyleOverview';
import { EnhancedJournalForm } from '@/components/journal/EnhancedJournalForm';
import { Button } from '@/components/ui/button';
import { useFundingRate, useLongShortRatio, useOpenInterest } from '@/hooks/useFutures';
import {
  useGlobalSignals,
  useLatestSignals,
  useLatestSignalForStyle,
  useComputeGlobalSignal,
} from '@/hooks/useSignals';
import { useFearAndGreed } from '@/hooks/useSentiment';
import { SentimentGauge } from '@/components/market/SentimentGauge';
import { useUIStore } from '@/stores/uiStore';
import { STYLE_CONFIGS } from '@/lib/indicators/style-configs';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import type { TradingStyle } from '@/lib/models/signal-template';

export default function SignalsPage() {
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);
  const [tradingStyle, setTradingStyle] = useState<TradingStyle>('day_trading');

  const styleConfig = STYLE_CONFIGS[tradingStyle];
  const preferredIntervals = styleConfig.preferredIntervals;
  const [interval, setInterval] = useState(preferredIntervals[0]);

  // Global signal data
  const { data: latestAllData, isLoading: latestAllLoading } = useLatestSignals(selectedSymbol);
  const { data: latestStyleData, isLoading: styleLoading } = useLatestSignalForStyle(
    selectedSymbol,
    tradingStyle
  );
  const { data: historyData, isLoading: historyLoading } = useGlobalSignals(
    selectedSymbol,
    tradingStyle,
    null,
    20
  );
  const computeMutation = useComputeGlobalSignal();

  // Futures data
  const { data: fundingData, isLoading: fundingLoading } = useFundingRate(selectedSymbol);
  const { data: oiData, isLoading: oiLoading } = useOpenInterest(selectedSymbol);
  const { data: lsData, isLoading: lsLoading } = useLongShortRatio(selectedSymbol);
  const { data: sentimentData } = useFearAndGreed();

  const latestSignal = latestStyleData?.signal ?? null;
  const futuresLoading = fundingLoading || oiLoading || lsLoading;
  const sentiment = sentimentData?.sentiment
    ? { fearGreedIndex: sentimentData.sentiment.fearGreedIndex, fearGreedLabel: sentimentData.sentiment.label }
    : null;

  function handleStyleChange(style: TradingStyle) {
    setTradingStyle(style);
    const newIntervals = STYLE_CONFIGS[style].preferredIntervals;
    if (!newIntervals.includes(interval)) {
      setInterval(newIntervals[0]);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Signals</h1>
        <AutoUpdateStatus
          tradingStyle={tradingStyle}
          lastUpdated={latestSignal?.createdAt ?? null}
        />
      </div>

      {/* Style tabs */}
      <StyleTabs value={tradingStyle} onValueChange={handleStyleChange} />

      {/* Symbol selector + interval + compute button */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {SIGNAL_SYMBOLS.map((sym) => (
            <Button
              key={sym}
              variant={selectedSymbol === sym ? 'default' : 'outline'}
              size="xs"
              onClick={() => setSelectedSymbol(sym)}
            >
              {sym.replace('USDT', '')}
            </Button>
          ))}
        </div>

        <select
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
          value={interval}
          onChange={(e) => setInterval(e.target.value)}
          data-testid="interval-select"
        >
          {preferredIntervals.map((iv) => (
            <option key={iv} value={iv}>
              {iv}
            </option>
          ))}
        </select>

        <Button
          size="sm"
          variant="default"
          onClick={() =>
            computeMutation.mutate({ symbol: selectedSymbol, interval, tradingStyle })
          }
          disabled={computeMutation.isPending}
          data-testid="compute-button"
        >
          {computeMutation.isPending ? 'Computing...' : 'Compute Now'}
        </Button>

        {latestSignal && (
          <EnhancedJournalForm
            symbol={selectedSymbol}
            interval={interval}
            score={latestSignal.score}
            tier={latestSignal.tier}
            confidence={latestSignal.confidence}
            sentiment={sentiment}
          />
        )}
      </div>

      {/* Main content grid */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Left column: Gauge + Breakdown */}
        <div className="lg:col-span-2 space-y-4">
          {/* Signal gauge */}
          <div className="rounded-lg border border-border p-4">
            {styleLoading ? (
              <div className="flex justify-center py-8">
                <div className="h-[168px] w-[240px] bg-muted animate-pulse rounded" />
              </div>
            ) : latestSignal ? (
              <ErrorBoundary
                fallback={<p className="text-sm text-muted-foreground">Gauge unavailable</p>}
              >
                <SignalGauge
                  score={latestSignal.score}
                  tier={latestSignal.tier}
                  confidence={latestSignal.confidence}
                />
              </ErrorBoundary>
            ) : (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No signal computed yet for {selectedSymbol}.
                <br />
                Click &quot;Compute Now&quot; to analyze.
              </div>
            )}
          </div>

          {/* Signal breakdown */}
          {latestSignal && latestSignal.components.length > 0 && (
            <div className="rounded-lg border border-border p-4">
              <h2 className="text-sm font-semibold mb-3">Signal Breakdown</h2>
              <ErrorBoundary
                fallback={
                  <p className="text-sm text-muted-foreground">Breakdown unavailable</p>
                }
              >
                <SignalBreakdown components={latestSignal.components} />
              </ErrorBoundary>
            </div>
          )}
        </div>

        {/* Right column: Multi-style overview + Futures + Sentiment */}
        <div className="space-y-4">
          {/* Multi-style comparison */}
          <div className="rounded-lg border border-border p-4">
            <h2 className="text-sm font-semibold mb-3">All Styles</h2>
            <ErrorBoundary
              fallback={
                <p className="text-sm text-muted-foreground">Overview unavailable</p>
              }
            >
              <MultiStyleOverview
                signals={
                  latestAllData?.signals ?? {
                    scalping: null,
                    day_trading: null,
                    swing_trading: null,
                    position_trading: null,
                  }
                }
                isLoading={latestAllLoading}
                activeStyle={tradingStyle}
                onStyleSelect={handleStyleChange}
              />
            </ErrorBoundary>
          </div>

          <div className="rounded-lg border border-border p-4">
            <h2 className="text-sm font-semibold mb-3">Futures Data</h2>
            <ErrorBoundary
              fallback={
                <p className="text-sm text-muted-foreground">Futures data unavailable</p>
              }
            >
              <FuturesPanel
                fundingRate={fundingData?.fundingRates?.[0] ?? null}
                openInterest={oiData?.openInterest ?? null}
                longShortRatio={lsData?.longShortRatio?.[0] ?? null}
                isLoading={futuresLoading}
              />
            </ErrorBoundary>
          </div>
          <div className="rounded-lg border border-border p-4">
            <h2 className="text-sm font-semibold mb-3">Market Sentiment</h2>
            <ErrorBoundary
              fallback={
                <p className="text-sm text-muted-foreground">Sentiment unavailable</p>
              }
            >
              <SentimentGauge />
            </ErrorBoundary>
          </div>
        </div>
      </div>

      {/* Signal history timeline */}
      <div className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold mb-3">Signal History</h2>
        <ErrorBoundary
          fallback={
            <p className="text-sm text-muted-foreground">History unavailable</p>
          }
        >
          <SignalTimeline
            signals={historyData?.signals ?? []}
            isLoading={historyLoading}
          />
        </ErrorBoundary>
      </div>

      {/* Compute error */}
      {computeMutation.isError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {computeMutation.error?.message || 'Failed to compute signal'}
        </div>
      )}
    </div>
  );
}
