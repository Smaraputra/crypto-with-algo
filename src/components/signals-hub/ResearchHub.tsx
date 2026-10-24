'use client';

import React, { useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  RESEARCH_CATALOG,
  RESEARCH_FAMILIES,
  LEDGER_TOTAL,
  type ResearchFamily,
  type ResearchStatus,
} from '@/content/research/catalog';
import { PageHeader } from '@/components/kit/PageHeader';
import { EvidenceChip } from '@/components/kit/EvidenceChip';
import { SegmentedControl } from '@/components/kit/SegmentedControl';
import { StateNotice } from '@/components/kit/StateNotice';
import {
  ResearchEntryCard,
  getStatusChipConfig,
} from './ResearchEntryCard';
import { cn } from '@/lib/utils';

const ALL_STATUS_ORDER: ResearchStatus[] = [
  'under-test',
  'rejected',
  'no-edge',
  'not-registered',
  'void',
  'descriptive',
  'validated',
];

const STATUS_FILTER_LABELS: Record<ResearchStatus, string> = {
  'under-test': 'Under test',
  rejected: 'Rejected',
  'no-edge': 'No edge',
  'not-registered': 'Not registered',
  void: 'Void',
  descriptive: 'Descriptive',
  validated: 'Validated',
};

export interface ResearchHubProps {
  className?: string;
}

export const ResearchHub: React.FC<ResearchHubProps> = ({ className }) => {
  const router = useRouter();
  const searchParams = useSearchParams();

  const presentStatuses = useMemo(() => {
    return ALL_STATUS_ORDER.filter((s) =>
      RESEARCH_CATALOG.some((entry) => entry.status === s)
    );
  }, []);

  const statusParam = searchParams.get('status') || 'all';
  const familyParam = searchParams.get('family') || 'all';

  const statusOptions = useMemo(() => {
    return [
      { value: 'all', label: 'All' },
      ...presentStatuses.map((s) => ({
        value: s,
        label: STATUS_FILTER_LABELS[s],
      })),
    ];
  }, [presentStatuses]);

  const familyOptions = useMemo(() => {
    return [
      { value: 'all', label: 'All' },
      ...Object.entries(RESEARCH_FAMILIES).map(([key, info]) => ({
        value: key,
        label: info.label,
      })),
    ];
  }, []);

  const updateFilters = (nextStatus: string, nextFamily: string) => {
    const params = new URLSearchParams();
    if (nextStatus && nextStatus !== 'all') {
      params.set('status', nextStatus);
    }
    if (nextFamily && nextFamily !== 'all') {
      params.set('family', nextFamily);
    }
    const qs = params.toString();
    router.replace(qs ? `/signals?${qs}` : '/signals', { scroll: false });
  };

  const handleStatusChange = (newStatus: string) => {
    updateFilters(newStatus, familyParam);
  };

  const handleFamilyChange = (newFamily: string) => {
    updateFilters(statusParam, newFamily);
  };

  const handleClearFilters = () => {
    updateFilters('all', 'all');
  };

  const filteredEntries = useMemo(() => {
    return RESEARCH_CATALOG.filter((entry) => {
      if (statusParam !== 'all' && entry.status !== statusParam) {
        return false;
      }
      if (familyParam !== 'all' && entry.family !== familyParam) {
        return false;
      }
      return true;
    });
  }, [statusParam, familyParam]);

  const groupedFamilies = useMemo(() => {
    const list: Array<{
      family: ResearchFamily;
      label: string;
      description: string;
      entries: typeof RESEARCH_CATALOG;
    }> = [];

    for (const [key, info] of Object.entries(RESEARCH_FAMILIES)) {
      const famKey = key as ResearchFamily;
      const entries = filteredEntries.filter((e) => e.family === famKey);
      if (entries.length > 0) {
        list.push({
          family: famKey,
          label: info.label,
          description: info.description,
          entries,
        });
      }
    }
    return list;
  }, [filteredEntries]);

  const formattedLedgerTotal = LEDGER_TOTAL.toLocaleString('en-US');

  return (
    <div className={cn('space-y-6', className)}>
      <PageHeader
        title="Signals and research"
        description="Every signal and study this project has tested, with how it was run, what it found and where the record lives. No rule is validated."
      />

      {/* Summary row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[14px] text-muted-foreground">
        <span className="font-sans tabular-nums font-semibold text-foreground">
          {formattedLedgerTotal} trials recorded in the ledger
        </span>
        <span className="text-edge" aria-hidden="true">&bull;</span>
        <div className="flex flex-wrap items-center gap-2.5">
          {presentStatuses.map((status) => {
            const count = RESEARCH_CATALOG.filter((e) => e.status === status).length;
            if (count === 0) return null;
            const chipConfig = getStatusChipConfig(status);
            return (
              <span
                key={status}
                className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground"
              >
                <span className="font-sans font-semibold tabular-nums text-foreground">
                  {count}
                </span>
                <EvidenceChip kind={chipConfig.kind} label={chipConfig.label} />
              </span>
            );
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3">
        <div className="overflow-x-auto pb-1 -mb-1">
          <SegmentedControl
            legend="Status"
            name="status-filter"
            options={statusOptions}
            value={statusParam}
            onChange={handleStatusChange}
          />
        </div>
        <div className="overflow-x-auto pb-1 -mb-1">
          <SegmentedControl
            legend="Family"
            name="family-filter"
            options={familyOptions}
            value={familyParam}
            onChange={handleFamilyChange}
          />
        </div>
      </div>

      {/* Entry List or Empty State */}
      {filteredEntries.length === 0 ? (
        <StateNotice
          kind="empty"
          title="No entries match these filters."
          action={
            <button
              type="button"
              onClick={handleClearFilters}
              className={cn(
                'min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[10px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer select-none',
                'hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline transition-colors duration-120',
                'active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100'
              )}
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <div className="space-y-10">
          {groupedFamilies.map((group) => (
            <section key={group.family} className="space-y-4">
              <div className="space-y-1">
                <h2 className="text-[20px] font-semibold text-foreground">
                  {group.label}
                </h2>
                <p className="text-[14px] text-muted-foreground leading-relaxed max-w-[70ch]">
                  {group.description}
                </p>
              </div>
              <div className="space-y-4">
                {group.entries.map((entry) => (
                  <ResearchEntryCard key={entry.id} entry={entry} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};
