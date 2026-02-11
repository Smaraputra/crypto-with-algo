'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { JournalEntryDetail } from './JournalEntryDetail';
import { useJournalEntries, type JournalFilters } from '@/hooks/useJournal';

interface JournalEntryListProps {
  filters: JournalFilters;
  onPageChange: (page: number) => void;
}

export function JournalEntryList({ filters, onPageChange }: JournalEntryListProps) {
  const { data, isLoading } = useJournalEntries(filters);

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="journal-list-loading">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  const entries = data?.entries ?? [];
  const totalPages = data?.totalPages ?? 1;
  const page = data?.page ?? 1;

  if (entries.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-12 text-center"
        data-testid="journal-list-empty"
      >
        <p className="text-sm text-muted-foreground">No journal entries found.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Log trades from the Signals page to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="journal-entry-list">
      {entries.map((entry) => (
        <JournalEntryDetail key={entry._id} entry={entry} />
      ))}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
