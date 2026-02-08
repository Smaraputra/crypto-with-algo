'use client';

import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useSymbols } from '@/hooks/useSymbols';
import { useUIStore } from '@/stores/uiStore';

export function SymbolSearch() {
  const [open, setOpen] = useState(false);
  const { data: symbols, isLoading } = useSymbols();
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  function handleSelect(symbol: string) {
    setSelectedSymbol(symbol);
    setOpen(false);
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-2 text-xs text-muted-foreground"
        onClick={() => setOpen(true)}
        aria-label="Search trading pairs"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="pointer-events-none hidden h-5 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
          <span className="text-xs">&#8984;</span>K
        </kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search Symbols"
        description="Find a crypto pair to view"
      >
        <CommandInput placeholder="Search symbol (e.g. BTC, ETH)..." />
        <CommandList>
          <CommandEmpty>
            {isLoading ? 'Loading symbols...' : 'No symbols found.'}
          </CommandEmpty>
          <CommandGroup heading="Trading Pairs">
            {symbols?.map((s) => (
              <CommandItem
                key={s.symbol}
                value={s.symbol}
                onSelect={() => handleSelect(s.symbol)}
              >
                <span className="font-medium">{s.baseAsset}</span>
                <span className="text-muted-foreground">/{s.quoteAsset}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
