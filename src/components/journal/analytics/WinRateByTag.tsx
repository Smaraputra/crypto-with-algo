'use client';

import type { TagPerformance } from '@/types/journal-analytics';

interface WinRateByTagProps {
  data: TagPerformance[];
}

export function WinRateByTag({ data }: WinRateByTagProps) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4" data-testid="win-rate-empty">
        No tag data yet. Tag your journal entries to see performance by tag.
      </p>
    );
  }

  const maxCount = Math.max(...data.map((d) => d.count));

  return (
    <div className="space-y-2" data-testid="win-rate-by-tag">
      {data.map((tag) => (
        <div key={tag.tag} className="space-y-0.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">{tag.tag}</span>
            <span className="text-muted-foreground">
              {tag.winRate.toFixed(0)}% ({tag.count} trades)
            </span>
          </div>
          <div className="relative h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="absolute left-0 top-0 h-full rounded-full transition-all"
              style={{
                width: `${(tag.count / maxCount) * 100}%`,
                backgroundColor: tag.winRate >= 50 ? '#0ecb81' : '#f6465d',
              }}
              data-testid={`tag-bar-${tag.tag}`}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>
              {tag.wins}W / {tag.losses}L
            </span>
            <span className="font-mono tabular-nums">
              Avg: {tag.avgPnlPercent > 0 ? '+' : ''}
              {tag.avgPnlPercent.toFixed(2)}%
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
