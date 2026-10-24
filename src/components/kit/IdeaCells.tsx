import React from 'react';
import { cn } from '@/lib/utils';

export interface IdeaCellsCounts {
  underTest: number;
  rejected: number;
  validated: number;
  notStarted?: number;
}

export interface IdeaCellsProps {
  counts: IdeaCellsCounts;
  label?: string;
  className?: string;
}

function generateAriaLabel(counts: IdeaCellsCounts, customLabel?: string): string {
  if (customLabel) return customLabel;

  const ut = counts.underTest ?? 0;
  const re = counts.rejected ?? 0;
  const va = counts.validated ?? 0;
  const ns = counts.notStarted ?? 0;

  const parts = [
    `${ut} ${ut === 1 ? 'idea' : 'ideas'} under test`,
    `${re} ${re === 1 ? 'rule' : 'rules'} rejected`,
    `${va} ${va === 1 ? 'idea' : 'ideas'} validated`,
  ];

  if (ns > 0) {
    parts.push(`${ns} not started`);
  }

  return parts.join(', ');
}

export const IdeaCells: React.FC<IdeaCellsProps> = ({
  counts,
  label,
  className,
}) => {
  const ariaLabel = generateAriaLabel(counts, label);

  const underTestCells = Array.from({ length: counts.underTest ?? 0 }, (_, i) => (
    <span
      key={`ut-${i}`}
      data-testid="idea-cell"
      data-kind="under-test"
      aria-hidden="true"
      className="relative w-[26px] h-[26px] rounded-[8px] border-2 border-foreground bg-transparent shrink-0 idea-cell-under-test"
    >
      <span className="absolute left-1/2 top-1 bottom-1 w-[2px] -translate-x-1/2 bg-foreground" />
    </span>
  ));

  const rejectedCells = Array.from({ length: counts.rejected ?? 0 }, (_, i) => (
    <span
      key={`re-${i}`}
      data-testid="idea-cell"
      data-kind="rejected"
      aria-hidden="true"
      className="relative w-[26px] h-[26px] rounded-[8px] bg-foreground text-background shrink-0 flex items-center justify-center idea-cell-rejected"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
        data-testid="rejected-marker"
      >
        <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
      </svg>
    </span>
  ));

  const validatedCells = Array.from({ length: counts.validated ?? 0 }, (_, i) => (
    <span
      key={`va-${i}`}
      data-testid="idea-cell"
      data-kind="validated"
      aria-hidden="true"
      className="relative w-[26px] h-[26px] rounded-[8px] bg-foreground text-background shrink-0 flex items-center justify-center idea-cell-validated"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        data-testid="validated-marker"
      >
        <path d="M2.5 6.5l2.5 2.5 4.5-5" />
      </svg>
    </span>
  ));

  const notStartedCells = Array.from({ length: counts.notStarted ?? 0 }, (_, i) => (
    <span
      key={`ns-${i}`}
      data-testid="idea-cell"
      data-kind="not-started"
      aria-hidden="true"
      className="relative w-[26px] h-[26px] rounded-[8px] border-2 border-dashed border-edge bg-transparent shrink-0 idea-cell-not-started"
    />
  ));

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={cn('flex flex-wrap gap-1.5 select-none', className)}
    >
      {underTestCells}
      {rejectedCells}
      {validatedCells}
      {notStartedCells}
    </div>
  );
};
