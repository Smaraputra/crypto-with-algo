'use client';

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { JournalFilterBar } from '@/components/journal/JournalFilterBar';
import { JournalEntryList } from '@/components/journal/JournalEntryList';
import { OpenTradesView } from '@/components/journal/OpenTradesView';
import { ClosedTradesView } from '@/components/journal/ClosedTradesView';
import { AnalyticsView } from '@/components/journal/analytics/AnalyticsView';
import { ManualJournalForm } from '@/components/journal/ManualJournalForm';
import { PnlSummaryStrip } from '@/components/journal/PnlSummaryStrip';
import { useJournalEntries } from '@/hooks/useJournal';
import type { JournalFilters } from '@/hooks/useJournal';

export default function JournalPage() {
  const [filters, setFilters] = useState<JournalFilters>({ page: 1 });
  const { data } = useJournalEntries();

  const totalUserEntries = data?.totalUserEntries ?? 0;
  const entryLimit = data?.entryLimit ?? 1000;

  function handlePageChange(page: number) {
    setFilters((prev) => ({ ...prev, page }));
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Trading Journal</h1>
        <ManualJournalForm />
      </div>

      <PnlSummaryStrip />

      {totalUserEntries > 900 && (
        <div
          className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400"
          data-testid="entry-limit-warning"
        >
          You have {totalUserEntries} of {entryLimit} journal entries.{' '}
          {totalUserEntries >= entryLimit
            ? 'Limit reached. Delete older entries to create new ones.'
            : 'Approaching the entry limit.'}
        </div>
      )}

      <Tabs defaultValue="entries">
        <TabsList>
          <TabsTrigger value="entries">Entries</TabsTrigger>
          <TabsTrigger value="open">Open Trades</TabsTrigger>
          <TabsTrigger value="closed">Closed Trades</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="entries" className="mt-4 space-y-4">
          <JournalFilterBar filters={filters} onChange={setFilters} />
          <JournalEntryList filters={filters} onPageChange={handlePageChange} />
        </TabsContent>

        <TabsContent value="open" className="mt-4">
          <OpenTradesView />
        </TabsContent>

        <TabsContent value="closed" className="mt-4">
          <ClosedTradesView />
        </TabsContent>

        <TabsContent value="analytics" className="mt-4">
          <AnalyticsView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
