'use client';

import React from 'react';
import { Panel } from '@/components/kit/Panel';
import { useLatestSignalForStyle } from '@/hooks/useSignals';
import type { TradingStyle } from '@/lib/models/signal-template';
import type { SignalComponent } from '@/types/signal';

export const CATEGORY_LABELS: Record<string, string> = {
  trend: 'Trend',
  momentum: 'Momentum',
  volume: 'Volume',
  volatility: 'Volatility',
  futures: 'Futures',
  sentiment: 'Sentiment',
  htf: 'Higher timeframe',
};

export function getComponentLabel(c: SignalComponent): string {
  const custom = c as unknown as { label?: string; name?: string };
  if (typeof custom.label === 'string' && custom.label.trim()) return custom.label;
  if (typeof custom.name === 'string' && custom.name.trim()) return custom.name;
  return CATEGORY_LABELS[c.category] ?? c.category;
}

export function formatContribution(val: number): string {
  if (Math.abs(val) < 0.05) return '0.0';
  const formatted = Math.abs(val).toFixed(1);
  return val > 0 ? `+${formatted}` : `-${formatted}`;
}

export interface ScoreComponentsProps {
  symbol?: string;
  style?: TradingStyle;
  interval?: string;
  components?: SignalComponent[];
  className?: string;
}

export const ScoreComponents: React.FC<ScoreComponentsProps> = ({
  symbol,
  style,
  interval,
  components: propComponents,
  className,
}) => {
  const query = useLatestSignalForStyle(
    propComponents ? null : symbol ?? null,
    propComponents ? null : style ?? null,
    propComponents ? null : interval ?? null
  );

  const components = propComponents ?? query.data?.signal?.components ?? [];

  if (components.length === 0) {
    return (
      <Panel title="What moved the score" className={className}>
        <p className="text-[14px] text-muted-foreground">No component details available.</p>
      </Panel>
    );
  }

  const maxExtent = Math.max(
    ...components.map((c) => Math.abs(c.weightedScore ?? 0)),
    0.01
  );

  const textAlternative = components
    .map((c) => `${getComponentLabel(c)}: ${formatContribution(c.weightedScore ?? 0)}`)
    .join(', ');

  return (
    <Panel title="What moved the score" className={className}>
      <div
        role="region"
        aria-label={`What moved the score: ${textAlternative}`}
        className="flex flex-col gap-3"
      >
        <span className="sr-only">{textAlternative}</span>

        {components.map((c) => {
          const label = getComponentLabel(c);
          const val = c.weightedScore ?? 0;
          const formatted = formatContribution(val);
          const ratio = Math.min(1, Math.abs(val) / maxExtent);
          const pct = (ratio * 100).toFixed(1);

          return (
            <div
              key={c.category}
              data-testid={`score-component-${c.category}`}
              className="flex items-center gap-3 text-[14px]"
            >
              <span className="w-28 sm:w-36 shrink-0 font-medium text-foreground truncate">
                {label}
              </span>

              {/* Centered true scale bar container */}
              <div
                className="relative flex-1 h-3 flex items-center bg-muted/40 rounded-full overflow-hidden"
                aria-hidden="true"
              >
                {/* Left side (negative) */}
                <div className="w-1/2 h-full flex justify-end items-center pr-[1px]">
                  {val < 0 && (
                    <div
                      data-testid={`bar-${c.category}`}
                      data-component-bar="true"
                      className="h-full bg-down rounded-l-full"
                      style={{ width: `${pct}%` }}
                    />
                  )}
                </div>

                {/* Center marker (0) */}
                <div className="w-[2px] h-full bg-edge shrink-0 z-10" />

                {/* Right side (positive) */}
                <div className="w-1/2 h-full flex justify-start items-center pl-[1px]">
                  {val > 0 && (
                    <div
                      data-testid={`bar-${c.category}`}
                      data-component-bar="true"
                      className="h-full bg-up rounded-r-full"
                      style={{ width: `${pct}%` }}
                    />
                  )}
                </div>
              </div>

              <span className="w-14 sm:w-16 shrink-0 text-right font-sans tabular-nums font-semibold text-foreground">
                {formatted}
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
};
