'use client';

import { useFearAndGreed } from '@/hooks/useSentiment';

function getColor(value: number): string {
  if (value <= 20) return '#f6465d'; // Extreme Fear - red
  if (value <= 40) return '#f0945d'; // Fear - orange
  if (value <= 60) return '#848e9c'; // Neutral - gray
  if (value <= 80) return '#93c47d'; // Greed - light green
  return '#0ecb81'; // Extreme Greed - green
}

function GaugeBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  const color = getColor(clamped);

  return (
    <div className="relative h-2 w-full rounded-full bg-muted overflow-hidden">
      <div
        className="absolute left-0 top-0 h-full rounded-full transition-all duration-500"
        style={{ width: `${clamped}%`, backgroundColor: color }}
        data-testid="gauge-fill"
      />
    </div>
  );
}

export function SentimentGauge() {
  const { data, isLoading, isError } = useFearAndGreed();

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="sentiment-gauge-loading">
        <div className="h-4 w-24 bg-muted animate-pulse rounded" />
        <div className="h-2 w-full bg-muted animate-pulse rounded-full" />
      </div>
    );
  }

  if (isError || !data?.sentiment) {
    return null;
  }

  const { fearGreedIndex, label } = data.sentiment;
  const color = getColor(fearGreedIndex);

  return (
    <div className="space-y-1.5" data-testid="sentiment-gauge">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Fear & Greed</span>
        <span className="font-mono tabular-nums font-medium" style={{ color }}>
          {fearGreedIndex} - {label}
        </span>
      </div>
      <GaugeBar value={fearGreedIndex} />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Extreme Fear</span>
        <span>Extreme Greed</span>
      </div>
    </div>
  );
}
