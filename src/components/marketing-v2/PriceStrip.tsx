'use client';

import React from 'react';
import { useTickers } from '@/hooks/usePrices';

const PLACEHOLDER_IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];

function formatPrice(lastPrice: string): string {
  const num = Number(lastPrice);
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

function formatChange(changePercent: string): { text: string; className: string } {
  const val = Number(changePercent);
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

export function PriceStrip() {
  const { data, isLoading, isError } = useTickers();

  if (isLoading) {
    return (
      <div
        data-testid="price-strip-loading"
        className="flex flex-wrap items-center justify-center gap-3 py-3 px-4"
      >
        {PLACEHOLDER_IDS.map((id) => (
          <div
            key={id}
            className="h-8 w-28 animate-pulse rounded-lg bg-muted"
          />
        ))}
      </div>
    );
  }

  if (isError || !data || data.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="price-strip"
      className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 py-3 px-4"
    >
      {data.map((ticker) => {
        const baseAsset = ticker.symbol.replace(/USDT$/, '');
        const formattedPrice = formatPrice(ticker.lastPrice);
        const change = formatChange(ticker.priceChangePercent);

        return (
          <div
            key={ticker.symbol}
            className="flex items-center gap-2 text-[14px] font-sans"
          >
            <span className="font-semibold text-foreground">{baseAsset}</span>
            <span className="tabular-nums text-foreground">{formattedPrice}</span>
            <span className={`tabular-nums font-medium ${change.className}`}>
              {change.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
