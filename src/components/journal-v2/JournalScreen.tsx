'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { PageHeader } from '@/components/kit/PageHeader';
import { SegmentedControl } from '@/components/kit/SegmentedControl';
import { Button } from '@/components/ui/button';
import { TradesView } from './TradesView';
import { StatsView } from './StatsView';
import { LogTradeSheet } from './LogTradeSheet';
import { EntrySheet } from './EntrySheet';
import type { JournalEntry } from '@/types/journal';

export interface JournalScreenProps {
  className?: string;
}

export const JournalScreen: React.FC<JournalScreenProps> = ({ className }) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const viewParam = searchParams.get('view');
  const activeView = viewParam === 'stats' ? 'stats' : 'trades';

  const [logTradeOpen, setLogTradeOpen] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<JournalEntry | null>(null);

  const handleViewChange = (val: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (val === 'stats') {
      params.set('view', 'stats');
    } else {
      params.delete('view');
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Journal"
        actions={
          <Button
            onClick={() => setLogTradeOpen(true)}
            className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-5"
          >
            Log a trade
          </Button>
        }
      />

      {/* Switcher: SegmentedControl with Trades | Stats, plus Notes link */}
      <div className="flex items-center">
        <div className="inline-flex items-center border border-edge rounded-[12px] p-[3px] gap-[2px] bg-card">
          <SegmentedControl
            legend="View"
            value={activeView}
            onChange={handleViewChange}
            options={[
              { value: 'trades', label: 'Trades' },
              { value: 'stats', label: 'Stats' },
            ]}
            className="border-0 p-0 bg-transparent rounded-none"
          />
          <Link
            href="/notes"
            className="min-w-[48px] min-h-[44px] px-3 inline-flex items-center justify-center rounded-[9px] font-semibold text-[14px] cursor-pointer select-none text-ink-2 hover:bg-muted hover:text-foreground transition-colors duration-120 active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[3px] focus-visible:outline"
          >
            Notes
          </Link>
        </div>
      </div>

      {activeView === 'stats' ? (
        <StatsView className={className} />
      ) : (
        <TradesView
          onSelectEntry={(entry) => setSelectedEntry(entry)}
          onOpenLogTrade={() => setLogTradeOpen(true)}
          className={className}
        />
      )}

      <LogTradeSheet open={logTradeOpen} onOpenChange={setLogTradeOpen} />

      <EntrySheet
        open={!!selectedEntry}
        onOpenChange={(open) => !open && setSelectedEntry(null)}
        entry={selectedEntry}
      />
    </div>
  );
};
