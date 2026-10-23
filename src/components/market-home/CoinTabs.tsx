'use client';

import React, { useMemo, useRef } from 'react';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useTickers } from '@/hooks/usePrices';
import { useUIStore } from '@/stores/uiStore';
import { cn } from '@/lib/utils';
import {
  formatCoinPrice,
  formatSignedPercent,
  getBaseAsset,
} from './formatters';
import type { Ticker24h } from '@/types/market';

export interface CoinTabsProps {
  className?: string;
}

export const CoinTabs: React.FC<CoinTabsProps> = ({ className }) => {
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);
  const { symbols, isLoading } = useWatchlist();
  const { tickers } = useBinanceTicker(symbols);
  const { data: tickersList } = useTickers();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const fallbackMap = useMemo(() => {
    const map = new Map<string, Ticker24h>();
    for (const t of tickersList ?? []) {
      map.set(t.symbol, t);
    }
    return map;
  }, [tickersList]);

  if (isLoading) {
    return (
      <div
        role="tablist"
        aria-label="Watchlist"
        className={cn(
          'flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden py-1',
          className
        )}
      >
        <div
          data-testid="coin-tab-placeholder"
          className="h-[44px] w-32 rounded-[10px] bg-muted shrink-0"
        />
        <div
          data-testid="coin-tab-placeholder"
          className="h-[44px] w-32 rounded-[10px] bg-muted shrink-0"
        />
        <div
          data-testid="coin-tab-placeholder"
          className="h-[44px] w-32 rounded-[10px] bg-muted shrink-0"
        />
      </div>
    );
  }

  if (symbols.length === 0) {
    return (
      <div
        role="tablist"
        aria-label="Watchlist"
        className={cn('flex items-center py-2', className)}
      >
        <p className="text-[14px] text-muted-foreground">
          Your watchlist is empty. Add coins from search (Ctrl K).
        </p>
      </div>
    );
  }

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const nextIndex = (index + 1) % symbols.length;
      setSelectedSymbol(symbols[nextIndex]);
      tabRefs.current[nextIndex]?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prevIndex = (index - 1 + symbols.length) % symbols.length;
      setSelectedSymbol(symbols[prevIndex]);
      tabRefs.current[prevIndex]?.focus();
    }
  };

  return (
    <div
      role="tablist"
      aria-label="Watchlist"
      className={cn(
        'flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden py-1',
        className
      )}
    >
      {symbols.map((symbol, index) => {
        const isSelected = symbol === selectedSymbol;
        const ticker = tickers[symbol] ?? fallbackMap.get(symbol);
        const base = getBaseAsset(symbol);
        const formattedPrice = formatCoinPrice(ticker?.lastPrice);
        const change = formatSignedPercent(ticker?.priceChangePercent);

        return (
          <button
            key={symbol}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            role="tab"
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => setSelectedSymbol(symbol)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              'min-h-[44px] h-[44px] px-3.5 inline-flex items-center gap-2 rounded-[10px] font-sans text-[14px] select-none shrink-0 cursor-pointer',
              'focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline transition-colors duration-120',
              'active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100',
              isSelected
                ? 'bg-foreground text-background shadow-xs'
                : 'bg-card text-foreground hover:bg-muted'
            )}
          >
            <span className="font-semibold">{base}</span>
            {formattedPrice && (
              <span className="tabular-nums text-[13px]">{formattedPrice}</span>
            )}
            <span
              className={cn(
                'tabular-nums text-[13px] font-medium',
                isSelected
                  ? 'text-background'
                  : change.direction === 'down'
                    ? 'text-down'
                    : 'text-up'
              )}
            >
              {change.formatted}
            </span>
          </button>
        );
      })}
    </div>
  );
};
