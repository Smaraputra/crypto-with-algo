'use client';

import { useId, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { CostCheckSymbolsResponse } from '@/types/cost-check';

interface SymbolPickerProps {
  value: string;
  onChange: (symbol: string) => void;
  symbols: CostCheckSymbolsResponse['symbols'] | undefined;
  isLoading: boolean;
  isError: boolean;
}

/** Searchable list of every trading crypto USDT-M perpetual. */
export function SymbolPicker({ value, onChange, symbols, isLoading, isError }: SymbolPickerProps) {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const buttonId = useId();
  const listId = useId();

  return (
    <div className="min-w-0 space-y-1">
      <span id={labelId} className="text-xs text-muted-foreground">
        Perpetual
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            id={buttonId}
            aria-expanded={open}
            aria-controls={listId}
            aria-labelledby={`${labelId} ${buttonId}`}
            className="h-9 w-full justify-between font-mono tabular-nums"
            data-testid="cost-check-symbol"
          >
            {value}
            <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] min-w-56 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search, e.g. SOL" />
            <CommandList id={listId}>
              <CommandEmpty>
                {isLoading ? 'Loading perpetuals...' : isError ? 'The list could not be loaded.' : 'No perpetual found.'}
              </CommandEmpty>
              <CommandGroup>
                {symbols?.map((s) => (
                  <CommandItem
                    key={s.symbol}
                    value={s.symbol}
                    onSelect={() => {
                      onChange(s.symbol);
                      setOpen(false);
                    }}
                    className="font-mono tabular-nums"
                  >
                    {s.baseAsset}
                    <span className="text-muted-foreground">USDT</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
