'use client';

import { X, Plus, Star } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useUIStore } from '@/stores/uiStore';

const POPULAR_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
  'MATICUSDT', 'UNIUSDT', 'LTCUSDT', 'ATOMUSDT', 'NEARUSDT',
];

export function WatchlistSidebar() {
  const { symbols, isLoading, addSymbol, removeSymbol } = useWatchlist();
  const { tickers } = useBinanceTicker(symbols);
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);
  const [search, setSearch] = useState('');

  const filteredAdd = POPULAR_SYMBOLS.filter(
    (s) => !symbols.includes(s) && s.toLowerCase().includes(search.toLowerCase())
  );

  if (isLoading) {
    return (
      <div className="space-y-2 p-1">
        <div className="flex items-center gap-2 px-2 py-1">
          <Star className="h-3.5 w-3.5 text-accent" />
          <span className="text-xs font-medium text-muted-foreground">Watchlist</span>
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-10 rounded-sm animate-shimmer" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-2 py-1">
        <div className="flex items-center gap-2">
          <Star className="h-3.5 w-3.5 text-accent" />
          <span className="text-xs font-medium text-muted-foreground">Watchlist</span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <div className="p-2">
              <Input
                placeholder="Search symbol..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-7 text-xs"
              />
            </div>
            <div className="max-h-48 overflow-y-auto">
              {filteredAdd.map((s) => (
                <DropdownMenuItem
                  key={s}
                  onClick={() => {
                    addSymbol(s);
                    setSearch('');
                  }}
                >
                  <span className="text-xs">{s.replace('USDT', '')}/USDT</span>
                </DropdownMenuItem>
              ))}
              {filteredAdd.length === 0 && (
                <div className="p-2 text-center text-xs text-muted-foreground">
                  No symbols found
                </div>
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {symbols.map((symbol) => {
        const ticker = tickers[symbol];
        const changePercent = ticker ? parseFloat(ticker.priceChangePercent) : 0;
        const isBullish = changePercent >= 0;

        return (
          <div
            key={symbol}
            role="button"
            tabIndex={0}
            onClick={() => setSelectedSymbol(symbol)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setSelectedSymbol(symbol);
              }
            }}
            className={cn(
              'group flex w-full cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-left transition-colors',
              'hover:bg-sidebar-accent',
              selectedSymbol === symbol && 'bg-sidebar-accent'
            )}
          >
            <div className="flex flex-col">
              <span className="text-xs font-medium">{symbol.replace('USDT', '')}</span>
              {ticker && (
                <span className="price-sm text-xs text-muted-foreground">
                  ${parseFloat(ticker.lastPrice).toLocaleString()}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {ticker && (
                <span
                  className={cn(
                    'text-xs font-medium',
                    isBullish ? 'text-bullish' : 'text-bearish'
                  )}
                >
                  {isBullish ? '+' : ''}{changePercent.toFixed(1)}%
                </span>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  removeSymbol(symbol);
                }}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
        );
      })}

      {symbols.length === 0 && (
        <div className="px-2 py-4 text-center text-xs text-muted-foreground">
          No symbols in watchlist
        </div>
      )}
    </div>
  );
}
