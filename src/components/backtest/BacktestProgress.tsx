'use client';

interface BacktestProgressProps {
  progress: number;
  barsProcessed: number;
  totalBars: number;
}

export function BacktestProgress({
  progress,
  barsProcessed,
  totalBars,
}: BacktestProgressProps) {
  return (
    <div className="space-y-2" data-testid="backtest-progress">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Processing bars...</span>
        <span className="font-mono tabular-nums">
          {barsProcessed} / {totalBars} ({progress}%)
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-accent transition-all duration-150"
          style={{ width: `${progress}%` }}
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}
