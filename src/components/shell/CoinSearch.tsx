'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { useSymbols } from '@/hooks/useSymbols';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useUIStore } from '@/stores/uiStore';
import { cn } from '@/lib/utils';

export interface CoinSearchProps {
  variant?: 'desktop' | 'icon';
  className?: string;
}

function getIsMac() {
  if (typeof window === 'undefined' || !navigator.userAgent) return false;
  return /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent);
}
function getServerIsMac() {
  return false;
}
function subscribeNoop() {
  return () => {};
}

export function CoinSearch({ variant = 'desktop', className }: CoinSearchProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const isMac = React.useSyncExternalStore(subscribeNoop, getIsMac, getServerIsMac);

  const router = useRouter();
  const { data: symbols, isLoading, isError } = useSymbols();
  const { symbols: watchlist, addSymbol, removeSymbol } = useWatchlist();
  const setSelectedSymbol = useUIStore((state) => state.setSelectedSymbol);

  useEffect(() => {
    if (variant !== 'desktop') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        const target = e.target as HTMLElement | null;
        const tagName = target?.tagName;
        const isInput =
          tagName === 'INPUT' ||
          tagName === 'TEXTAREA' ||
          target?.isContentEditable;
        if (isInput) return;
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [variant]);

  const handleSelect = (symbol: string) => {
    setSelectedSymbol(symbol);
    setOpen(false);
    setSearch('');
    router.push(`/focus?symbol=${encodeURIComponent(symbol)}`);
  };

  const normalized = search.trim().toLowerCase();
  const allSymbols = symbols ?? [];
  const filtered = normalized
    ? allSymbols.filter(
        (s) =>
          s.symbol.toLowerCase().includes(normalized) ||
          s.baseAsset.toLowerCase().includes(normalized)
      )
    : allSymbols;

  const watchlistSet = new Set(watchlist ?? []);

  return (
    <>
      {variant === 'desktop' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Search coins"
          className={cn(
            'inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-0 rounded-[10px] border border-edge px-0 text-sm font-medium text-ink-2 select-none',
            'xl:justify-start xl:gap-3 xl:px-3.5',
            'transition-colors duration-120 hover:bg-muted hover:text-foreground',
            'active:scale-[0.98] motion-reduce:active:scale-100',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            className
          )}
        >
          <Search className="size-4 shrink-0 text-ink-2" />
          <span className="hidden xl:inline">Search coins</span>
          <kbd className="pointer-events-none hidden rounded border border-edge bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-ink-2 xl:inline-block">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Search"
          className={cn(
            'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[10px] text-ink-2 select-none',
            'transition-colors duration-120 hover:bg-muted hover:text-foreground',
            'active:scale-[0.98] motion-reduce:active:scale-100',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            className
          )}
        >
          <Search className="size-5" />
        </button>
      )}

      <CommandDialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setSearch('');
        }}
        title="Search coins"
        description="Filter and search for coins"
      >
        <CommandInput
          placeholder="Search coins..."
          value={search}
          onValueChange={setSearch}
        />
        <CommandList className="max-h-[350px]">
          {isLoading && (
            <div className="py-6 text-center text-sm text-ink-2">Loading coins.</div>
          )}

          {isError && (
            <div className="py-6 text-center text-sm text-destructive">
              Coins did not load.
            </div>
          )}

          {!isLoading && !isError && filtered.length === 0 && (
            <CommandEmpty>No coins match.</CommandEmpty>
          )}

          {!isLoading && !isError && filtered.length > 0 && (
            <CommandGroup heading="Coins">
              {filtered.map((s) => {
                const inWatchlist = watchlistSet.has(s.symbol);
                return (
                  <CommandItem
                    key={s.symbol}
                    value={`${s.symbol} ${s.baseAsset}`}
                    onSelect={() => handleSelect(s.symbol)}
                    className="flex min-h-[44px] cursor-pointer items-center justify-between px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-foreground">{s.baseAsset}</span>
                      <span className="text-xs text-muted-foreground">{s.symbol}</span>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        if (inWatchlist) {
                          removeSymbol(s.symbol);
                        } else {
                          addSymbol(s.symbol);
                        }
                      }}
                      className={cn(
                        'inline-flex min-h-[36px] cursor-pointer items-center rounded-md border border-edge px-2.5 text-xs font-semibold',
                        'hover:bg-muted active:scale-[0.98] motion-reduce:active:scale-100',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                        inWatchlist ? 'text-ink-2' : 'text-foreground'
                      )}
                    >
                      {inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
                    </button>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
