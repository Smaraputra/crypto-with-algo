'use client';

import type { FundingRate, LongShortRatio, OpenInterest } from '@/types/futures';

interface FuturesPanelProps {
  fundingRate?: FundingRate | null;
  openInterest?: OpenInterest | null;
  longShortRatio?: LongShortRatio | null;
  isLoading?: boolean;
}

function formatFundingRate(rate: number): string {
  return `${(rate * 100).toFixed(4)}%`;
}

function formatNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(2);
}

function FundingRateColor(rate: number): string {
  if (rate > 0.001) return 'var(--signal-strong-sell)'; // High positive = bearish
  if (rate > 0) return 'var(--signal-sell)';
  if (rate < -0.001) return 'var(--signal-strong-buy)'; // Negative = bullish
  if (rate < 0) return 'var(--signal-buy)';
  return 'var(--signal-neutral)';
}

function LSRatioColor(ratio: number): string {
  if (ratio > 1.5) return 'var(--signal-strong-sell)'; // Heavily long = bearish contrarian
  if (ratio > 1.1) return 'var(--signal-sell)';
  if (ratio < 0.67) return 'var(--signal-strong-buy)'; // Heavily short = bullish contrarian
  if (ratio < 0.9) return 'var(--signal-buy)';
  return 'var(--signal-neutral)';
}

export function FuturesPanel({
  fundingRate,
  openInterest,
  longShortRatio,
  isLoading,
}: FuturesPanelProps) {
  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="futures-panel">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  const hasData = fundingRate || openInterest || longShortRatio;

  if (!hasData) {
    return (
      <div
        className="text-sm text-muted-foreground text-center py-4"
        data-testid="futures-panel"
      >
        No futures data available
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="futures-panel">
      {/* Funding Rate */}
      {fundingRate && (
        <div className="flex items-center justify-between rounded-md border border-border p-3">
          <div>
            <div className="text-xs text-muted-foreground">Funding Rate</div>
            <div
              className="font-mono text-sm font-semibold tabular-nums"
              style={{ color: FundingRateColor(fundingRate.fundingRate) }}
              data-testid="funding-rate-value"
            >
              {formatFundingRate(fundingRate.fundingRate)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Mark Price</div>
            <div className="font-mono text-sm tabular-nums">
              ${formatNumber(fundingRate.markPrice)}
            </div>
          </div>
        </div>
      )}

      {/* Open Interest */}
      {openInterest && (
        <div className="flex items-center justify-between rounded-md border border-border p-3">
          <div>
            <div className="text-xs text-muted-foreground">Open Interest</div>
            <div
              className="font-mono text-sm font-semibold tabular-nums"
              data-testid="open-interest-value"
            >
              {formatNumber(openInterest.openInterest)}
            </div>
          </div>
        </div>
      )}

      {/* Long/Short Ratio */}
      {longShortRatio && (
        <div className="rounded-md border border-border p-3">
          <div className="text-xs text-muted-foreground mb-2">Long/Short Ratio</div>
          <div className="flex items-center justify-between">
            <div
              className="font-mono text-sm font-semibold tabular-nums"
              style={{ color: LSRatioColor(longShortRatio.longShortRatio) }}
              data-testid="ls-ratio-value"
            >
              {longShortRatio.longShortRatio.toFixed(2)}
            </div>
            <div className="flex gap-3 text-xs">
              <span>
                <span className="text-muted-foreground">L: </span>
                <span className="font-mono tabular-nums text-bullish">
                  {(longShortRatio.longAccount * 100).toFixed(1)}%
                </span>
              </span>
              <span>
                <span className="text-muted-foreground">S: </span>
                <span className="font-mono tabular-nums text-bearish">
                  {(longShortRatio.shortAccount * 100).toFixed(1)}%
                </span>
              </span>
            </div>
          </div>

          {/* Visual bar */}
          <div className="mt-2 flex h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-bullish"
              style={{ width: `${longShortRatio.longAccount * 100}%` }}
            />
            <div
              className="bg-bearish"
              style={{ width: `${longShortRatio.shortAccount * 100}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
