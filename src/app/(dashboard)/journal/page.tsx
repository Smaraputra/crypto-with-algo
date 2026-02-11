'use client';

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { JournalFilterBar } from '@/components/journal/JournalFilterBar';
import { JournalEntryList } from '@/components/journal/JournalEntryList';
import { ReviewQueue } from '@/components/journal/ReviewQueue';
import type { JournalFilters } from '@/hooks/useJournal';

export default function JournalPage() {
  const [filters, setFilters] = useState<JournalFilters>({ page: 1 });

  function handlePageChange(page: number) {
    setFilters((prev) => ({ ...prev, page }));
  }

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-lg font-semibold">Trading Journal</h1>

      <Tabs defaultValue="entries">
        <TabsList>
          <TabsTrigger value="entries">Entries</TabsTrigger>
          <TabsTrigger value="review">Review Queue</TabsTrigger>
          <TabsTrigger value="playbook">Playbook</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="entries" className="mt-4 space-y-4">
          <JournalFilterBar filters={filters} onChange={setFilters} />
          <JournalEntryList filters={filters} onPageChange={handlePageChange} />
        </TabsContent>

        <TabsContent value="review" className="mt-4">
          <ReviewQueue />
        </TabsContent>

        <TabsContent value="playbook" className="mt-4">
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-muted-foreground">
              Research notes and playbook coming soon.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="analytics" className="mt-4">
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-muted-foreground">
              Journal analytics coming soon.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
