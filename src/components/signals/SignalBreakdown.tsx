'use client';

import type { SignalComponent } from '@/types/signal';

interface SignalBreakdownProps {
  components: SignalComponent[];
}

const CATEGORY_LABELS: Record<string, string> = {
  trend: 'Trend',
  momentum: 'Momentum',
  volume: 'Volume',
  volatility: 'Volatility',
  futures: 'Futures',
  sentiment: 'Sentiment',
};

function ScoreBar({ score }: { score: number }) {
  // score is -100 to +100, map to width percentage from center
  const absScore = Math.min(100, Math.abs(score));
  const isPositive = score >= 0;

  return (
    <div className="flex items-center gap-2 w-full">
      <div className="relative h-2 flex-1 rounded-full bg-muted overflow-hidden">
        {/* Center line */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-muted-foreground/30" />
        {/* Score fill */}
        <div
          className="absolute top-0 bottom-0 rounded-full transition-all duration-300"
          style={{
            left: isPositive ? '50%' : `${50 - absScore / 2}%`,
            width: `${absScore / 2}%`,
            backgroundColor: isPositive ? 'var(--bullish)' : 'var(--bearish)',
          }}
          data-testid="score-bar-fill"
        />
      </div>
      <span
        className="text-xs font-mono tabular-nums w-10 text-right"
        style={{ color: score > 0 ? 'var(--bullish)' : score < 0 ? 'var(--bearish)' : 'var(--signal-neutral)' }}
      >
        {score > 0 ? '+' : ''}{Math.round(score)}
      </span>
    </div>
  );
}

function DirectionBadge({ direction }: { direction: string }) {
  const colors: Record<string, string> = {
    bullish: 'bg-bullish-muted text-bullish',
    bearish: 'bg-bearish-muted text-bearish',
    neutral: 'bg-muted text-muted-foreground',
  };

  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${colors[direction] || colors.neutral}`}>
      {direction}
    </span>
  );
}

export function SignalBreakdown({ components }: SignalBreakdownProps) {
  return (
    <div className="space-y-4" data-testid="signal-breakdown">
      {components.map((component) => (
        <div key={component.category} className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                {CATEGORY_LABELS[component.category] || component.category}
              </span>
              {component.weight > 0 && (
                <span className="text-xs text-muted-foreground">
                  ({Math.round(component.weight * 100)}%)
                </span>
              )}
            </div>
            <span
              className="text-xs font-mono tabular-nums"
              style={{
                color: component.weightedScore > 0 ? 'var(--bullish)' : component.weightedScore < 0 ? 'var(--bearish)' : 'var(--signal-neutral)',
              }}
            >
              {component.weightedScore > 0 ? '+' : ''}
              {component.weightedScore.toFixed(1)}
            </span>
          </div>

          <ScoreBar score={component.score} />

          {/* Individual indicator badges */}
          {component.signals.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1">
              {component.signals.map((signal) => (
                <div
                  key={signal.name}
                  className="flex items-center gap-1"
                  title={signal.description}
                >
                  <DirectionBadge direction={signal.direction} />
                  <span className="text-xs text-muted-foreground">{signal.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
