'use client';

import { useState } from 'react';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { FuturesPanel } from '@/components/signals/FuturesPanel';
import { SignalBreakdown } from '@/components/signals/SignalBreakdown';
import { SignalGauge } from '@/components/signals/SignalGauge';
import { JournalForm } from '@/components/backtest/JournalForm';
import { Button } from '@/components/ui/button';
import { useFundingRate, useLongShortRatio, useOpenInterest } from '@/hooks/useFutures';
import { useComputeSignal, useLatestSignal, useSignals } from '@/hooks/useSignals';
import { useUIStore } from '@/stores/uiStore';

function SignalHistory({ symbol }: { symbol: string }) {
  const { data, isLoading } = useSignals(symbol, null, 20);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-10 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  const signals = data?.signals ?? [];

  if (signals.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4">
        No signal history yet. Click &quot;Compute Now&quot; to generate a signal.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto" data-testid="signal-history">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-4">Time</th>
            <th className="pb-2 pr-4">Score</th>
            <th className="pb-2 pr-4">Tier</th>
            <th className="pb-2">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((signal) => (
            <tr key={signal._id} className="border-b border-border/50">
              <td className="py-2 pr-4 text-xs text-muted-foreground">
                {new Date(signal.createdAt).toLocaleString()}
              </td>
              <td className="py-2 pr-4 font-mono tabular-nums">
                <span
                  style={{
                    color: signal.score > 0 ? '#0ecb81' : signal.score < 0 ? '#f6465d' : '#848e9c',
                  }}
                >
                  {signal.score > 0 ? '+' : ''}
                  {Math.round(signal.score)}
                </span>
              </td>
              <td className="py-2 pr-4 text-xs capitalize">
                {signal.tier.replace('_', ' ')}
              </td>
              <td className="py-2 text-xs">{signal.confidence}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SignalsPage() {
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);
  const [interval, setInterval] = useState('1h');

  const { data: latestData, isLoading: signalLoading } = useLatestSignal(selectedSymbol);
  const computeMutation = useComputeSignal();

  const { data: fundingData, isLoading: fundingLoading } = useFundingRate(selectedSymbol);
  const { data: oiData, isLoading: oiLoading } = useOpenInterest(selectedSymbol);
  const { data: lsData, isLoading: lsLoading } = useLongShortRatio(selectedSymbol);

  const latestSignal = latestData?.signals?.[0];
  const futuresLoading = fundingLoading || oiLoading || lsLoading;

  const popularSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Signals</h1>
      </div>

      {/* Symbol selector + interval + compute button */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {popularSymbols.map((sym) => (
            <Button
              key={sym}
              variant={selectedSymbol === sym ? 'default' : 'outline'}
              size="sm"
              className="text-xs"
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
          <option value="15m">15m</option>
          <option value="1h">1h</option>
          <option value="4h">4h</option>
          <option value="1d">1D</option>
        </select>

        <Button
          size="sm"
          variant="default"
          className="text-xs"
          onClick={() =>
            computeMutation.mutate({ symbol: selectedSymbol, interval })
          }
          disabled={computeMutation.isPending}
          data-testid="compute-button"
        >
          {computeMutation.isPending ? 'Computing...' : 'Compute Now'}
        </Button>

        {latestSignal && (
          <JournalForm
            symbol={selectedSymbol}
            interval={interval}
            score={latestSignal.score}
            tier={latestSignal.tier}
          />
        )}
      </div>

      {/* Main content grid */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Left column: Gauge + Breakdown */}
        <div className="lg:col-span-2 space-y-4">
          {/* Signal gauge */}
          <div className="rounded-lg border border-border p-4">
            {signalLoading ? (
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
          {latestSignal && (
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

        {/* Right column: Futures panel */}
        <div className="space-y-4">
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
        </div>
      </div>

      {/* Signal history */}
      <div className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold mb-3">Signal History</h2>
        <ErrorBoundary
          fallback={
            <p className="text-sm text-muted-foreground">History unavailable</p>
          }
        >
          <SignalHistory symbol={selectedSymbol} />
        </ErrorBoundary>
      </div>

      {/* Compute error */}
      {computeMutation.isError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
          {computeMutation.error?.message || 'Failed to compute signal'}
        </div>
      )}
    </div>
  );
}
