'use client';

import type { GlobalSignalRecord } from '@/hooks/useSignals';

interface SignalTimelineProps {
  signals: GlobalSignalRecord[];
  isLoading: boolean;
}

function MiniSparkline({ scores }: { scores: number[] }) {
  if (scores.length < 2) return null;

  const width = 200;
  const height = 40;
  const padding = 2;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;

  const min = Math.min(-10, ...scores);
  const max = Math.max(10, ...scores);
  const range = max - min || 1;

  const points = scores.map((s, i) => {
    const x = padding + (i / (scores.length - 1)) * innerW;
    const y = padding + innerH - ((s - min) / range) * innerH;
    return `${x},${y}`;
  });

  // Zero line
  const zeroY = padding + innerH - ((0 - min) / range) * innerH;

  const lastScore = scores[scores.length - 1];
  const color = lastScore > 0 ? 'var(--bullish)' : lastScore < 0 ? 'var(--bearish)' : 'var(--signal-neutral)';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="w-full h-10"
      role="img"
      aria-label={`Signal score trend: ${scores.length} data points`}
      data-testid="signal-sparkline"
    >
      {/* Zero reference line */}
      <line
        x1={padding}
        y1={zeroY}
        x2={width - padding}
        y2={zeroY}
        stroke="hsl(var(--muted-foreground))"
        strokeWidth={0.5}
        strokeDasharray="2,2"
        opacity={0.4}
      />
      {/* Score line */}
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SignalTimeline({ signals, isLoading }: SignalTimelineProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        <div className="h-10 bg-muted animate-pulse rounded" />
        <div className="h-20 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  if (signals.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4">
        No signal history available.
      </p>
    );
  }

  // Reverse so oldest is first for the sparkline (left = oldest, right = newest)
  const chronological = [...signals].reverse();
  const scores = chronological.map((s) => s.score);

  return (
    <div className="space-y-3" data-testid="signal-timeline">
      <MiniSparkline scores={scores} />

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-2 pr-4">Time</th>
              <th className="pb-2 pr-4">Interval</th>
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
                <td className="py-2 pr-4 text-xs text-muted-foreground">
                  {signal.interval}
                </td>
                <td className="py-2 pr-4 font-mono tabular-nums">
                  <span
                    className={
                      signal.score > 0
                        ? 'text-bullish'
                        : signal.score < 0
                          ? 'text-bearish'
                          : 'text-muted-foreground'
                    }
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
    </div>
  );
}
