'use client';

import type { TradingStyle } from '@/lib/models/signal-template';
import type { GlobalSignalRecord } from '@/hooks/useSignals';
import { STYLE_LABELS } from './StyleTabs';

interface MultiStyleOverviewProps {
  signals: Record<TradingStyle, GlobalSignalRecord | null>;
  isLoading: boolean;
  activeStyle: TradingStyle;
  onStyleSelect: (style: TradingStyle) => void;
}

const STYLES: TradingStyle[] = [
  'scalping',
  'day_trading',
  'swing_trading',
  'position_trading',
];

function scoreColorClass(score: number): string {
  if (score > 0) return 'text-bullish';
  if (score < 0) return 'text-bearish';
  return 'text-muted-foreground';
}

function tierLabel(tier: string): string {
  return tier.replace(/_/g, ' ');
}

export function MultiStyleOverview({
  signals,
  isLoading,
  activeStyle,
  onStyleSelect,
}: MultiStyleOverviewProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-2" data-testid="multi-style-overview">
        {STYLES.map((s) => (
          <div key={s} className="h-20 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2" data-testid="multi-style-overview">
      {STYLES.map((style) => {
        const signal = signals[style];
        const isActive = style === activeStyle;

        return (
          <button
            key={style}
            className={`rounded-lg border p-3 text-left transition-colors ${
              isActive
                ? 'border-accent bg-accent/10'
                : 'border-border hover:border-muted-foreground/50'
            }`}
            onClick={() => onStyleSelect(style)}
            data-testid={`overview-${style}`}
          >
            <div className="text-xs font-medium text-muted-foreground mb-1">
              {STYLE_LABELS[style]}
            </div>
            {signal ? (
              <>
                <div
                  className={`text-lg font-mono tabular-nums font-semibold ${scoreColorClass(signal.score)}`}
                >
                  {signal.score > 0 ? '+' : ''}
                  {Math.round(signal.score)}
                </div>
                <div className="text-xs text-muted-foreground capitalize">
                  {tierLabel(signal.tier)}
                </div>
              </>
            ) : (
              <div className="text-xs text-muted-foreground">No data</div>
            )}
          </button>
        );
      })}
    </div>
  );
}
