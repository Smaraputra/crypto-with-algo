'use client';

import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { useGlobalSignals } from '@/hooks/useSignals';
import { tierDisplayLabel } from '@/lib/signals/tier-labels';
import { cn } from '@/lib/utils';
import { EvidenceTag } from './EvidenceTag';

export interface ScoreDirectionProps {
  symbol: string;
  interval: '15m' | '1h';
  className?: string;
}

const CATEGORIES = [
  'trend',
  'momentum',
  'volume',
  'volatility',
  'futures',
  'sentiment',
  'htf',
] as const;

const CATEGORY_NAMES: Record<(typeof CATEGORIES)[number], string> = {
  trend: 'Trend',
  momentum: 'Momentum',
  volume: 'Volume',
  volatility: 'Volatility',
  futures: 'Futures',
  sentiment: 'Sentiment',
  htf: 'Htf',
};

export function ScoreDirection({
  symbol,
  interval,
  className,
}: ScoreDirectionProps) {
  const headingId = useId();
  const { data, isLoading, error, refetch } = useGlobalSignals(
    symbol,
    'day_trading',
    interval,
    2
  );

  if (isLoading) {
    return (
      <section
        aria-labelledby={headingId}
        data-testid="score-direction"
        className={cn('space-y-3 p-4', className)}
      >
        <div className="flex items-center justify-between">
          <h3 id={headingId} className="text-sm font-semibold">Signal score (v8)</h3>
          <EvidenceTag kind="no-edge" />
        </div>
        <p role="status" className="text-sm text-muted-foreground">
          Loading signal scores...
        </p>
      </section>
    );
  }

  if (error) {
    return (
      <section
        aria-labelledby={headingId}
        data-testid="score-direction"
        className={cn('space-y-3 p-4', className)}
      >
        <div className="flex items-center justify-between">
          <h3 id={headingId} className="text-sm font-semibold">Signal score (v8)</h3>
          <EvidenceTag kind="no-edge" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive">
            Could not load signal scores: {error.message}.
          </p>
          <Button
            variant="outline"
            size="xs"
            className="min-h-11 sm:min-h-6"
            onClick={() => void refetch()}
          >
            Retry
          </Button>
        </div>
      </section>
    );
  }

  if (!data?.signals || data.signals.length === 0) {
    return (
      <section
        aria-labelledby={headingId}
        data-testid="score-direction"
        className={cn('space-y-3 p-4', className)}
      >
        <div className="flex items-center justify-between">
          <h3 id={headingId} className="text-sm font-semibold">Signal score (v8)</h3>
          <EvidenceTag kind="no-edge" />
        </div>
        <p className="text-sm text-muted-foreground">
          No stored score for this coin and interval yet.
        </p>
      </section>
    );
  }

  const latest = data.signals[0];
  const previous = data.signals.length > 1 ? data.signals[1] : undefined;

  const totalScoreFormatted =
    latest.score > 0
      ? `+${Math.round(latest.score)}`
      : `${Math.round(latest.score)}`;
  const tierText = tierDisplayLabel(latest.tier);

  return (
    <section
      aria-labelledby={headingId}
      data-testid="score-direction"
      className={cn('space-y-3 p-4', className)}
    >
      <div className="flex items-center justify-between">
        <h3 id={headingId} className="text-sm font-semibold">Signal score (v8)</h3>
        <EvidenceTag kind="no-edge" />
      </div>

      <div className="flex items-center justify-between border-b border-border/50 pb-2">
        <span className="font-mono tabular-nums text-base font-semibold">
          {totalScoreFormatted}
        </span>
        <span className="text-xs text-muted-foreground">{tierText}</span>
      </div>

      <ul className="space-y-1 text-xs">
        {CATEGORIES.map((cat) => {
          const currComp = latest.components?.find((c) => c.category === cat);
          const currScore = currComp ? currComp.score : 0;
          const prevComp = previous?.components?.find(
            (c) => c.category === cat
          );

          let arrowGlyph: string | null = null;
          let arrowLabel: string | undefined = undefined;

          if (previous && prevComp !== undefined) {
            if (currScore > prevComp.score) {
              arrowGlyph = '▲';
              arrowLabel = 'higher than the previous bar';
            } else if (currScore < prevComp.score) {
              arrowGlyph = '▼';
              arrowLabel = 'lower than the previous bar';
            } else {
              arrowGlyph = '=';
              arrowLabel = 'equal to the previous bar';
            }
          }

          const formattedScore =
            currScore > 0
              ? `+${Math.round(currScore)}`
              : `${Math.round(currScore)}`;

          return (
            <li
              key={cat}
              data-testid={`score-category-${cat}`}
              className="flex items-center justify-between py-1 border-b border-border/50 last:border-b-0"
            >
              <span className="text-muted-foreground">
                {CATEGORY_NAMES[cat]}
              </span>
              <div className="flex items-center gap-1.5 font-mono tabular-nums">
                <span>{formattedScore}</span>
                {arrowGlyph && (
                  <span
                    aria-label={arrowLabel}
                    title={arrowLabel}
                    className="text-muted-foreground"
                  >
                    {arrowGlyph}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
