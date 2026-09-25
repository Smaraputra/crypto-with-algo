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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { SESSION_LABELS, type MarketSession } from '@/lib/sessions';
import { DisciplineBanner } from '@/components/journal/DisciplineBanner';
import { useDiscipline } from '@/hooks/useDiscipline';
import { useJournalAnalytics } from '@/hooks/useJournalAnalytics';
import { useFundingRate, useLongShortRatio, useOpenInterest } from '@/hooks/useFutures';
import {
  useGlobalSignals,
  useLatestSignals,
  useLatestSignalForStyle,
} from '@/hooks/useSignals';
import { useFearAndGreed } from '@/hooks/useSentiment';
import { SentimentGauge } from '@/components/market/SentimentGauge';
import { useUIStore } from '@/stores/uiStore';
import { STYLE_CONFIGS } from '@/lib/indicators/style-configs';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import type { TradingStyle } from '@/lib/models/signal-template';
import { formatWinRate } from '@/components/journal/analytics/format';

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
    tradingStyle,
    interval
  );
  const { data: historyData, isLoading: historyLoading } = useGlobalSignals(
    selectedSymbol,
    tradingStyle,
    interval,
    20
  );
  // Futures data
  const { data: fundingData, isLoading: fundingLoading } = useFundingRate(selectedSymbol);
  const { data: oiData, isLoading: oiLoading } = useOpenInterest(selectedSymbol);
  const { data: lsData, isLoading: lsLoading } = useLongShortRatio(selectedSymbol);
  const { data: sentimentData } = useFearAndGreed();

  const latestSignal = latestStyleData?.signal ?? null;
  const { data: disciplineNudges } = useDiscipline(selectedSymbol);
  const { data: journalAnalytics } = useJournalAnalytics();

  // Your own record on this tier: informational calibration, never score-altering
  const tierRecord =
    latestSignal && journalAnalytics?.bySignalTier
      ? (journalAnalytics.bySignalTier.find((t) => t.tier === latestSignal.tier) ?? null)
      : null;
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
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Signals</h1>
        <AutoUpdateStatus
          tradingStyle={tradingStyle}
          lastUpdated={latestSignal?.createdAt ?? null}
        />
      </div>

      {/* Discipline nudges (advisory only) */}
      <DisciplineBanner nudges={disciplineNudges ?? []} compact />

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
          <Card>
            <CardContent>
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
                  {(latestSignal.htfContext || latestSignal.session) && (
                    <div
                      className="mt-3 flex flex-wrap justify-center gap-2"
                      data-testid="signal-context-chips"
                    >
                      {latestSignal.htfContext && (
                        <span
                          className={cn(
                            'rounded-full border border-border px-2 py-0.5 text-xs',
                            latestSignal.htfContext.trendDirection === 'bullish'
                              ? 'text-bullish'
                              : latestSignal.htfContext.trendDirection === 'bearish'
                                ? 'text-bearish'
                                : 'text-muted-foreground'
                          )}
                          data-testid="htf-chip"
                        >
                          {latestSignal.htfContext.interval} trend:{' '}
                          {latestSignal.htfContext.trendDirection}
                        </span>
                      )}
                      {latestSignal.session && (
                        <span
                          className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
                          data-testid="session-chip"
                        >
                          {SESSION_LABELS[latestSignal.session as MarketSession] ??
                            latestSignal.session}{' '}
                          session
                        </span>
                      )}
                    </div>
                  )}
                  {tierRecord && tierRecord.count >= 5 && (
                    <p
                      className="mt-2 text-center text-xs text-muted-foreground"
                      data-testid="tier-record-hint"
                    >
                      Your {latestSignal.tier.replace('_', ' ')} record:{' '}
                      <span className="font-mono tabular-nums">
                        {formatWinRate(tierRecord.winRate, 0)}
                      </span>{' '}
                      win rate over {tierRecord.count} journaled trades
                    </p>
                  )}
                </ErrorBoundary>
              ) : (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No signal computed yet for {selectedSymbol}.
                  <br />
                  Signals are computed on a schedule; the next run will fill this in.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Signal breakdown */}
          {latestSignal && latestSignal.components.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Signal Breakdown</CardTitle>
              </CardHeader>
              <CardContent>
                <ErrorBoundary
                  fallback={
                    <p className="text-sm text-muted-foreground">Breakdown unavailable</p>
                  }
                >
                  <SignalBreakdown components={latestSignal.components} />
                </ErrorBoundary>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right column: Multi-style overview + Futures + Sentiment */}
        <div className="space-y-4">
          {/* Multi-style comparison */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">All Styles</CardTitle>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Futures Data</CardTitle>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Market Sentiment</CardTitle>
            </CardHeader>
            <CardContent>
              <ErrorBoundary
                fallback={
                  <p className="text-sm text-muted-foreground">Sentiment unavailable</p>
                }
              >
                <SentimentGauge />
              </ErrorBoundary>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Signal history timeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Signal History</CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

    </div>
  );
}
