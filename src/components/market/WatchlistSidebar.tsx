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
import { useDailyLevels } from '@/hooks/useDailyLevels';
import {
  levelLabel,
  levelProximity,
  type LevelProximity,
  type PriorDayLevels,
} from '@/lib/market/levels';
import { useUIStore } from '@/stores/uiStore';

function levelTitle(proximity: LevelProximity, levels: PriorDayLevels): string {
  const levelPrice = levels[proximity.level];
  const formattedPrice = levelPrice.toLocaleString(undefined, { maximumFractionDigits: 8 });
  if (proximity.distanceAtr === 0) {
    return `at the prior UTC day's ${proximity.level} (${formattedPrice}). Descriptive only, not a signal.`;
  }
  const direction = proximity.distanceAtr < 0 ? 'below' : 'above';
  const atrDistance = Math.abs(proximity.distanceAtr).toFixed(1);
  return `${atrDistance} daily ATR ${direction} the prior UTC day's ${proximity.level} (${formattedPrice}). Descriptive only, not a signal.`;
}

const POPULAR_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
  'MATICUSDT', 'UNIUSDT', 'LTCUSDT', 'ATOMUSDT', 'NEARUSDT',
];

export function WatchlistSidebar() {
  const { symbols, isLoading, addSymbol, removeSymbol } = useWatchlist();
  const { tickers } = useBinanceTicker(symbols);
  const { data: levelsData } = useDailyLevels(symbols);
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);
  const setMobileSidebarOpen = useUIStore((s) => s.setMobileSidebarOpen);

  const selectSymbol = (symbol: string) => {
    setSelectedSymbol(symbol);
    setMobileSidebarOpen(false);
  };
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
        const levels = levelsData?.levels[symbol] ?? null;
        const proximity =
          ticker && levels ? levelProximity(parseFloat(ticker.lastPrice), levels) : null;

        return (
          <div
            key={symbol}
            role="button"
            tabIndex={0}
            onClick={() => selectSymbol(symbol)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectSymbol(symbol);
              }
            }}
            className={cn(
              'group flex min-h-[2.75rem] w-full cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-left transition-colors',
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
              {proximity && levels && (
                <span
                  data-testid={`level-${symbol}`}
                  className={cn(
                    'font-mono tabular-nums text-[10px] leading-tight',
                    proximity.near ? 'text-foreground' : 'text-muted-foreground/70'
                  )}
                  title={levelTitle(proximity, levels)}
                >
                  {proximity.distanceAtr === 0
                    ? `${levelLabel(proximity.level)} at`
                    : `${levelLabel(proximity.level)} ${Math.abs(proximity.distanceAtr).toFixed(1)} ATR ${proximity.distanceAtr < 0 ? 'below' : 'above'}`}
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
                aria-label={`Remove ${symbol.replace('USDT', '')} from watchlist`}
                className="h-7 w-7 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
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
