'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { JournalEntryDetail } from './JournalEntryDetail';
import { useJournalEntries } from '@/hooks/useJournal';
import type { JournalEntry } from '@/types/journal';

export function ReviewQueue() {
  const { data, isLoading } = useJournalEntries({ limit: 100 });

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="review-queue-loading">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  const entries = data?.entries ?? [];
  const unreviewedEntries = entries.filter(
    (entry: JournalEntry) => entry.exitPrice != null && entry.reviewedAt == null
  );

  if (unreviewedEntries.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-12 text-center"
        data-testid="review-queue-empty"
      >
        <p className="text-sm text-muted-foreground">No trades to review.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Closed trades that haven&apos;t been reviewed will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="review-queue">
      <p className="text-xs text-muted-foreground">
        {unreviewedEntries.length} trade{unreviewedEntries.length !== 1 ? 's' : ''} awaiting review
      </p>
      {unreviewedEntries.map((entry: JournalEntry) => (
        <JournalEntryDetail key={entry._id} entry={entry} />
      ))}
    </div>
  );
}
