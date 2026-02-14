'use client';

import { useJournalAnalytics } from '@/hooks/useJournalAnalytics';
import { AnalyticsSummaryCards } from './AnalyticsSummaryCards';
import { WinRateByTag } from './WinRateByTag';
import { PerformanceBySetup } from './PerformanceBySetup';
import { MonthlyPnL } from './MonthlyPnL';
import { SignalAccuracy } from './SignalAccuracy';
import { TradingPatterns } from './TradingPatterns';

export function AnalyticsView() {
  const { data, isLoading, isError } = useJournalAnalytics();

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="analytics-loading">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8" data-testid="analytics-error">
        Failed to load analytics. Please try again.
      </p>
    );
  }

  return (
    <div className="space-y-6" data-testid="analytics-view">
      {data.incompleteTradeCount > 0 && (
        <div
          className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-400"
          data-testid="incomplete-trade-banner"
        >
          {data.incompleteTradeCount} trade{data.incompleteTradeCount !== 1 ? 's' : ''} without
          P&L data. Close open trades with an exit price for more accurate analytics.
        </div>
      )}

      <AnalyticsSummaryCards summary={data.summary} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-semibold mb-3">Monthly P&L</h3>
          <MonthlyPnL data={data.byMonth} />
        </div>

        <div className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-semibold mb-3">Trading Patterns</h3>
          <TradingPatterns summary={data.summary} byMonth={data.byMonth} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-semibold mb-3">Win Rate by Tag</h3>
          <WinRateByTag data={data.byTag} />
        </div>

        <div className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-semibold mb-3">Signal Accuracy</h3>
          <SignalAccuracy data={data.bySignalTier} />
        </div>
      </div>

      <div className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold mb-3">Performance by Setup</h3>
        <PerformanceBySetup data={data.bySetupType} />
      </div>
    </div>
  );
}
