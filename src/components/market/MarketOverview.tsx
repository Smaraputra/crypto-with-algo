'use client';

import { useTickers } from '@/hooks/usePrices';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useUIStore } from '@/stores/uiStore';
import { PriceCard } from './PriceCard';
import type { Ticker24h } from '@/types/market';

export const DEFAULT_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT',
];

export function MarketOverview() {
  const { data: restTickers, isLoading } = useTickers();
  const { tickers: liveTickers, isConnected } = useBinanceTicker(DEFAULT_SYMBOLS);
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-24 rounded-sm animate-shimmer" />
        ))}
      </div>
    );
  }

  const mergedTickers = DEFAULT_SYMBOLS.map((symbol) => {
    const live = liveTickers[symbol];
    const rest = restTickers?.find((t) => t.symbol === symbol);
    return (live ?? rest ?? null) as Ticker24h | null;
  }).filter(Boolean) as Ticker24h[];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
      {mergedTickers.map((ticker) => (
        <PriceCard
          key={ticker.symbol}
          ticker={ticker}
          isLive={isConnected && !!liveTickers[ticker.symbol]}
          selected={ticker.symbol === selectedSymbol}
          onClick={() => setSelectedSymbol(ticker.symbol)}
        />
      ))}
    </div>
  );
}
