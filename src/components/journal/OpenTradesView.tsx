'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { JournalEntryDetail } from './JournalEntryDetail';
import { useJournalEntries } from '@/hooks/useJournal';
import type { JournalEntry } from '@/types/journal';

export function OpenTradesView() {
  const { data, isLoading } = useJournalEntries({ status: 'open', limit: 50 });

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="open-trades-loading">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  const entries = data?.entries ?? [];

  if (entries.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-12 text-center"
        data-testid="open-trades-empty"
      >
        <p className="text-sm text-muted-foreground">No open trades.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Create a journal entry with an entry price to track open positions.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="open-trades-list">
      <p className="text-xs text-muted-foreground">
        {entries.length} open trade{entries.length !== 1 ? 's' : ''}
      </p>
      {entries.map((entry: JournalEntry) => (
        <JournalEntryDetail key={entry._id} entry={entry} />
      ))}
    </div>
  );
}
