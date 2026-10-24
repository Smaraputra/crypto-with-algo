'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTickers } from '@/hooks/usePrices';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useMarketStreamStatus } from '@/hooks/useMarketStream';
import { cn } from '@/lib/utils';
import type { Ticker24h } from '@/types/market';

export interface LiveTickerProps {
  symbols?: string[];
}

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];

function formatPrice(lastPrice: string | number | undefined | null): string {
  if (lastPrice === undefined || lastPrice === null || lastPrice === '') return 'n/a';
  const num = typeof lastPrice === 'number' ? lastPrice : Number(lastPrice);
  if (isNaN(num)) return 'n/a';
  if (num >= 1000) {
    return `$${num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  } else if (num >= 1) {
    return `$${num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    })}`;
  } else {
    return `$${num.toLocaleString('en-US', {
      minimumFractionDigits: 4,
      maximumFractionDigits: 6,
    })}`;
  }
}

function formatChange(changePercent: string | number | undefined | null): { text: string; className: string } {
  if (changePercent === undefined || changePercent === null || changePercent === '') {
    return { text: 'n/a', className: 'text-muted-foreground' };
  }
  const val = typeof changePercent === 'number' ? changePercent : Number(changePercent);
  if (isNaN(val)) {
    return { text: 'n/a', className: 'text-muted-foreground' };
  }
  if (val > 0) {
    return { text: `+${val.toFixed(2)}%`, className: 'text-up' };
  }
  if (val < 0) {
    return { text: `${val.toFixed(2)}%`, className: 'text-down' };
  }
  return { text: '0.00%', className: 'text-muted-foreground' };
}

export function LiveTicker({ symbols = DEFAULT_SYMBOLS }: LiveTickerProps) {
  const { data: polledTickers, isLoading } = useTickers();
  const { tickers: streamTickers } = useBinanceTicker(symbols);
  const { isConnected } = useMarketStreamStatus();

  const prevPricesRef = useRef<Record<string, number>>({});
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [tints, setTints] = useState<Record<string, 'up' | 'down' | null>>({});

  useEffect(() => {
    const isReduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    symbols.forEach((sym) => {
      const ticker = streamTickers[sym] ?? polledTickers?.find((t) => t.symbol === sym);
      if (!ticker) return;

      const priceNum = Number(ticker.lastPrice);
      if (isNaN(priceNum)) return;

      const prevPrice = prevPricesRef.current[sym];
      if (prevPrice === undefined) {
        prevPricesRef.current[sym] = priceNum;
        return;
      }

      if (priceNum !== prevPrice) {
        prevPricesRef.current[sym] = priceNum;
        if (!isReduced) {
          const dir = priceNum > prevPrice ? 'up' : 'down';
          setTints((prev) => ({ ...prev, [sym]: dir }));

          if (timersRef.current[sym]) {
            clearTimeout(timersRef.current[sym]);
          }
          timersRef.current[sym] = setTimeout(() => {
            setTints((prev) => ({ ...prev, [sym]: null }));
            delete timersRef.current[sym];
          }, 700);
        }
      }
    });
  }, [symbols, streamTickers, polledTickers]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  const hasAnyData =
    Boolean(polledTickers && polledTickers.length > 0) ||
    Object.keys(streamTickers).length > 0;
  const showLoading = isLoading && !hasAnyData;

  return (
    <div className="flex flex-col">
      <ul aria-label="Live prices" className="flex flex-col gap-2">
        {showLoading
          ? symbols.map((sym) => (
              <li
                key={sym}
                data-testid="ticker-row-placeholder"
                className="h-11 flex items-center justify-between py-2 px-3 rounded-lg border border-line bg-card/60"
              >
                <div className="h-4 w-12 rounded bg-muted animate-pulse" />
                <div className="flex items-center gap-3">
                  <div className="h-4 w-20 rounded bg-muted animate-pulse" />
                  <div className="h-4 w-14 rounded bg-muted animate-pulse" />
                </div>
              </li>
            ))
          : symbols.map((sym) => {
              const baseAsset = sym.replace(/USDT$/, '');
              const activeTicker: Ticker24h | undefined =
                streamTickers[sym] ?? polledTickers?.find((t) => t.symbol === sym);

              const formattedPrice = activeTicker
                ? formatPrice(activeTicker.lastPrice)
                : 'n/a';
              const change = activeTicker
                ? formatChange(activeTicker.priceChangePercent)
                : { text: 'n/a', className: 'text-muted-foreground' };
              const tint = tints[sym];
              const tintClass =
                tint === 'up' ? 'bg-up/15' : tint === 'down' ? 'bg-down/15' : '';

              return (
                <li
                  key={sym}
                  data-testid="ticker-row"
                  className="h-11 flex items-center justify-between py-2 px-3 rounded-lg border border-line bg-card/60"
                >
                  <span className="font-semibold text-foreground text-sm">
                    {baseAsset}
                  </span>
                  <div className="flex items-center gap-3 text-sm">
                    <span
                      data-testid={`ticker-price-${sym}`}
                      className={cn(
                        'tabular-nums font-medium text-foreground px-1.5 py-0.5 rounded transition-colors duration-700',
                        formattedPrice === 'n/a' && 'text-muted-foreground',
                        tintClass
                      )}
                    >
                      {formattedPrice}
                    </span>
                    <span
                      className={cn(
                        'tabular-nums font-medium text-xs',
                        change.className
                      )}
                    >
                      {change.text}
                    </span>
                  </div>
                </li>
              );
            })}
      </ul>

      <div className="flex items-center gap-2 mt-3 text-xs">
        <span
          data-testid="ticker-status-dot"
          className={cn(
            'inline-block h-2 w-2 rounded-full',
            isConnected ? 'bg-up' : 'bg-muted-foreground'
          )}
        />
        <span
          className={
            isConnected ? 'text-foreground' : 'text-muted-foreground'
          }
        >
          {isConnected ? 'Live from Binance' : 'Reconnecting'}
        </span>
      </div>
    </div>
  );
}
