'use client';

import React from 'react';
import { PageHeader } from '@/components/kit/PageHeader';
import { StateNotice } from '@/components/kit/StateNotice';
import { Button } from '@/components/ui/button';
import { AdminTabs } from './AdminTabs';
import { BookPanel } from './BookPanel';
import { usePaperDesk } from '@/hooks/usePaperDesk';
import { cn } from '@/lib/utils';

export interface PaperDeskScreenProps {
  className?: string;
}

export const PaperDeskScreen: React.FC<PaperDeskScreenProps> = ({ className }) => {
  const query = usePaperDesk();

  const isEmpty =
    query.data &&
    (!query.data.books || query.data.books.length === 0);

  return (
    <div className={cn('space-y-6', className)}>
      <PageHeader
        title="Paper desk"
        description="Paper books that trade the price score rule on live bars. Records only, no money at risk."
      />

      <AdminTabs currentPath="/admin/paper-desk" />

      {query.isLoading && (
        <StateNotice kind="loading" title="Loading paper desk..." />
      )}

      {query.isError && (
        <StateNotice
          kind="error"
          title="The paper desk did not load."
          description={query.error?.message || 'Unable to retrieve paper desk records.'}
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => query.refetch()}
              className="min-h-[44px] px-4 rounded-[12px] font-semibold"
            >
              Try again
            </Button>
          }
        />
      )}

      {query.data && isEmpty && (
        <StateNotice
          kind="empty"
          title="No paper books yet."
        />
      )}

      {query.data && !isEmpty && query.data.books && (
        <div className="space-y-6">
          {query.data.books.map((book) => (
            <BookPanel key={book.book} book={book} />
          ))}
        </div>
      )}
    </div>
  );
};
