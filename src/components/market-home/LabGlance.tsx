'use client';

import React from 'react';
import Link from 'next/link';
import { Panel } from '@/components/kit/Panel';
import { EvidenceChip, type EvidenceKind } from '@/components/kit/EvidenceChip';
import { IdeaCells } from '@/components/kit/IdeaCells';
import { StateNotice } from '@/components/kit/StateNotice';
import { useLabSummary } from '@/components/lab/useLabSummary';
import { cn } from '@/lib/utils';

export interface LabGlanceProps {
  className?: string;
}

export const LabGlance: React.FC<LabGlanceProps> = ({ className }) => {
  const { counts, isLoading, isError, refetchFailed } = useLabSummary();

  if (isError) {
    return (
      <Panel title="Lab" className={className}>
        <StateNotice
          kind="error"
          title="The lab did not load."
          action={
            <button
              type="button"
              onClick={refetchFailed}
              className={cn(
                'min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[10px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer',
                'hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline transition-colors duration-120',
                'active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100'
              )}
            >
              Try again
            </button>
          }
        />
      </Panel>
    );
  }

  if (isLoading) {
    return (
      <Panel title="Lab" className={className}>
        <StateNotice kind="loading" title="Loading the lab." />
      </Panel>
    );
  }

  const chipKind: EvidenceKind =
    counts.validated > 0
      ? 'validated'
      : counts.underTest > 0
        ? 'under-test'
        : 'not-started';

  return (
    <Panel
      title="Lab"
      action={<EvidenceChip kind={chipKind} />}
      className={cn('flex flex-col', className)}
    >
      <div className="mb-4">
        <IdeaCells counts={counts} />
      </div>

      <p className="text-[15px] font-semibold text-foreground leading-normal">
        {counts.underTest} under test, {counts.validated} validated.
      </p>

      <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
        Evidence is updated every hour at 20 minutes past.
      </p>

      <div className="mt-4 pt-1">
        <Link
          href="/lab"
          className={cn(
            'min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[10px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer',
            'hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline transition-colors duration-120',
            'active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100'
          )}
        >
          Open the lab record
        </Link>
      </div>
    </Panel>
  );
};
