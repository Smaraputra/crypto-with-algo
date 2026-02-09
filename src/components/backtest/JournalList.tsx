'use client';

import { useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { JournalEntryCard } from './JournalEntryCard';
import { useJournalEntries, useDeleteJournalEntry } from '@/hooks/useJournal';

const SYMBOL_FILTERS = ['All', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'] as const;

export function JournalList() {
  const [symbolFilter, setSymbolFilter] = useState<string | undefined>(undefined);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { data, isLoading } = useJournalEntries(symbolFilter);
  const deleteMutation = useDeleteJournalEntry();

  const entries = data?.entries ?? [];

  const handleDelete = (id: string) => {
    setDeletingId(id);
    deleteMutation.mutate(id, {
      onSettled: () => setDeletingId(null),
    });
  };

  return (
    <div className="space-y-3" data-testid="journal-list">
      <div className="flex flex-wrap gap-1">
        {SYMBOL_FILTERS.map((sym) => (
          <Button
            key={sym}
            size="sm"
            variant={
              (sym === 'All' && !symbolFilter) || symbolFilter === sym
                ? 'default'
                : 'outline'
            }
            className="h-6 text-[10px]"
            onClick={() => setSymbolFilter(sym === 'All' ? undefined : sym)}
          >
            {sym === 'All' ? 'All' : sym.replace('USDT', '')}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-2" data-testid="journal-list-loading">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p
          className="py-8 text-center text-sm text-muted-foreground"
          data-testid="journal-list-empty"
        >
          No journal entries yet. Log signals from the Signals page to start tracking.
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <JournalEntryCard
              key={entry._id}
              entry={entry}
              onDelete={handleDelete}
              isDeleting={deletingId === entry._id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
