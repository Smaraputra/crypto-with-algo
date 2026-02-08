'use client';

import type { KLineData } from 'klinecharts';

interface ChartLegendProps {
  symbol: string;
  kLineData: KLineData | null;
}

function formatVolume(volume: number): string {
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(2)}M`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(2)}K`;
  return volume.toFixed(2);
}

function formatPrice(price: number): string {
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(8);
}

export function ChartLegend({ symbol, kLineData }: ChartLegendProps) {
  if (!kLineData) return null;

  const { open, high, low, close, volume } = kLineData;
  const isBullish = close >= open;
  const change = close - open;
  const changePct = open !== 0 ? (change / open) * 100 : 0;
  const colorClass = isBullish ? 'text-bullish' : 'text-bearish';

  return (
    <div
      className="pointer-events-none absolute left-2 top-2 z-20 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded bg-background/70 px-2 py-1 text-xs font-mono tabular-nums"
      data-testid="chart-legend"
    >
      <span className="font-medium text-foreground">{symbol}</span>
      <span>
        O <span className={colorClass}>{formatPrice(open)}</span>
      </span>
      <span>
        H <span className={colorClass}>{formatPrice(high)}</span>
      </span>
      <span>
        L <span className={colorClass}>{formatPrice(low)}</span>
      </span>
      <span>
        C <span className={colorClass}>{formatPrice(close)}</span>
      </span>
      <span>
        Vol <span className="text-muted-foreground">{formatVolume(volume ?? 0)}</span>
      </span>
      <span className={colorClass}>
        {change >= 0 ? '+' : ''}{formatPrice(change)} ({changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%)
      </span>
    </div>
  );
}
