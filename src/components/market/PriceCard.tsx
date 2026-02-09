'use client';

import { memo, useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import type { Ticker24h } from '@/types/market';

interface PriceCardProps {
  ticker: Ticker24h;
  isLive?: boolean;
  onClick?: () => void;
  selected?: boolean;
}

export const PriceCard = memo(function PriceCard({ ticker, isLive, onClick, selected }: PriceCardProps) {
  const [prevPrice, setPrevPrice] = useState(ticker.lastPrice);
  const [flashClass, setFlashClass] = useState('');
  const clearFlash = useCallback(() => setFlashClass(''), []);

  // React-recommended pattern: derive state from props during render
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  if (prevPrice !== ticker.lastPrice) {
    const direction =
      parseFloat(ticker.lastPrice) > parseFloat(prevPrice)
        ? 'animate-flash-up'
        : 'animate-flash-down';
    setFlashClass(direction);
    setPrevPrice(ticker.lastPrice);
  }

  // Clear flash class after animation completes
  useEffect(() => {
    if (!flashClass) return;
    const timer = setTimeout(clearFlash, 400);
    return () => clearTimeout(timer);
  }, [flashClass, clearFlash]);

  const changePercent = parseFloat(ticker.priceChangePercent);
  const isBullish = changePercent >= 0;
  const symbol = ticker.symbol.replace('USDT', '');

  return (
    <button
      onClick={onClick}
      aria-label={`Select ${symbol}/USDT`}
      className={cn(
        'flex w-full flex-col gap-1 rounded-sm border p-3 text-left transition-colors',
        'hover:bg-card-hover',
        selected ? 'border-primary/40 bg-card-hover' : 'border-border bg-card',
        flashClass
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{symbol}/USDT</span>
        {isLive && <div className="h-1.5 w-1.5 rounded-full bg-bullish animate-pulse" />}
      </div>
      <span className="price-md">
        ${parseFloat(ticker.lastPrice).toLocaleString('en-US')}
      </span>
      <span
        className={cn(
          'text-xs font-medium',
          isBullish ? 'text-bullish' : 'text-bearish'
        )}
      >
        {isBullish ? '+' : ''}
        {changePercent.toFixed(2)}%
      </span>
    </button>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.ticker.lastPrice === nextProps.ticker.lastPrice &&
    prevProps.ticker.priceChangePercent === nextProps.ticker.priceChangePercent &&
    prevProps.isLive === nextProps.isLive &&
    prevProps.selected === nextProps.selected
  );
});
