'use client';

import React, { useMemo } from 'react';
import Link from 'next/link';
import { useUIStore } from '@/stores/uiStore';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useTickers } from '@/hooks/usePrices';
import { PriceFigure } from '@/components/kit/PriceFigure';
import { cn } from '@/lib/utils';
import {
  formatCoinPrice,
  formatSignedPercent,
  getBaseAsset,
  getQuoteAsset,
} from './formatters';

export interface PriceHeroProps {
  symbol?: string;
  className?: string;
}

export const PriceHero: React.FC<PriceHeroProps> = ({
  symbol: propSymbol,
  className,
}) => {
  const storeSymbol = useUIStore((s) => s.selectedSymbol);
  const symbol = propSymbol ?? storeSymbol;

  const symbolArray = useMemo(() => [symbol], [symbol]);
  const { tickers } = useBinanceTicker(symbolArray);
  const { data: tickersList } = useTickers();

  const ticker = useMemo(() => {
    return (
      tickers[symbol] ??
      tickersList?.find((t) => t.symbol === symbol)
    );
  }, [tickers, tickersList, symbol]);

  const base = getBaseAsset(symbol);
  const quote = getQuoteAsset(symbol);
  const formattedPrice = formatCoinPrice(ticker?.lastPrice);
  const change = formatSignedPercent(ticker?.priceChangePercent);

  return (
    <section
      aria-label="Price hero"
      className={cn(
        'flex flex-col sm:flex-row sm:items-end justify-between gap-3 py-3',
        className
      )}
    >
      <div className="flex flex-col">
        <span className="text-[13px] font-medium text-muted-foreground">
          {base} / {quote}
        </span>
        {formattedPrice ? (
          <PriceFigure
            value={formattedPrice}
            change={{
              value: change.formatted,
              direction: change.direction,
            }}
            size="large"
            className="my-1 [&_[data-testid=price-value]]:sm:text-[64px]"
          />
        ) : (
          <div
            data-testid="price-placeholder"
            aria-label="Loading price"
            className="h-[48px] sm:h-[64px] w-64 rounded-[10px] bg-muted animate-pulse my-1"
          />
        )}
      </div>

      <div className="shrink-0 pb-1">
        <Link
          href={`/focus?symbol=${symbol}`}
          className={cn(
            'min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[10px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer',
            'hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline transition-colors duration-120',
            'active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100'
          )}
        >
          Study this coin
        </Link>
      </div>
    </section>
  );
};
