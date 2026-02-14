'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { JournalEntryDetail } from './JournalEntryDetail';
import { useJournalEntries } from '@/hooks/useJournal';
import type { JournalEntry } from '@/types/journal';

export function ClosedTradesView() {
  const { data, isLoading } = useJournalEntries({ status: 'closed', limit: 50 });

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="closed-trades-loading">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  const entries = data?.entries ?? [];
  const unreviewedCount = entries.filter((e: JournalEntry) => e.reviewedAt == null).length;

  if (entries.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-12 text-center"
        data-testid="closed-trades-empty"
      >
        <p className="text-sm text-muted-foreground">No closed trades.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Close an open trade by entering an exit price to see it here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="closed-trades-list">
      <div className="flex items-center gap-2">
        <p className="text-xs text-muted-foreground">
          {entries.length} closed trade{entries.length !== 1 ? 's' : ''}
        </p>
        {unreviewedCount > 0 && (
          <Badge variant="secondary" className="text-xs">
            {unreviewedCount} unreviewed
          </Badge>
        )}
      </div>
      {entries.map((entry: JournalEntry) => (
        <JournalEntryDetail key={entry._id} entry={entry} />
      ))}
    </div>
  );
}
