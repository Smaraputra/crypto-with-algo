import React from 'react';
import { cn } from '@/lib/utils';

export type EvidenceKind =
  | 'untested'
  | 'no-edge'
  | 'under-test'
  | 'validated'
  | 'rejected'
  | 'context'
  | 'not-started';

export interface EvidenceChipProps {
  kind: EvidenceKind;
  label?: string;
  href?: string;
  className?: string;
}

const DEFAULT_LABELS: Record<EvidenceKind, string> = {
  untested: 'Untested',
  'no-edge': 'No edge (measured)',
  'under-test': 'Under test',
  validated: 'Validated',
  rejected: 'Rejected',
  context: 'Context',
  'not-started': 'Not started',
};

function renderGlyph(kind: EvidenceKind) {
  switch (kind) {
    case 'untested':
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="w-4 h-4 shrink-0"
        >
          <circle
            cx="8"
            cy="8"
            r="6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeDasharray="2.6 2.4"
          />
        </svg>
      );
    case 'no-edge':
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="w-4 h-4 shrink-0"
        >
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
          <path d="M5 8h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'under-test':
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="w-4 h-4 shrink-0 text-brand-line"
        >
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
        </svg>
      );
    case 'validated':
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="w-4 h-4 shrink-0"
        >
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5 8.2l2 2 4-4.4"
            fill="none"
            stroke="var(--background)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'rejected':
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="w-4 h-4 shrink-0"
        >
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'context':
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="w-4 h-4 shrink-0"
        >
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="8" cy="8" r="2" fill="currentColor" />
        </svg>
      );
    case 'not-started':
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="w-4 h-4 shrink-0"
        >
          <rect
            x="2.5"
            y="2.5"
            width="11"
            height="11"
            rx="2.5"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      );
  }
}

const KIND_CONTAINER_CLASSES: Record<EvidenceKind, string> = {
  untested: 'border border-dashed border-edge bg-transparent',
  'no-edge': 'border border-transparent bg-muted',
  'under-test': 'border border-brand-line bg-card',
  validated: 'border border-transparent bg-muted',
  rejected: 'border-2 border-foreground bg-transparent',
  context: 'border border-transparent bg-muted',
  'not-started': 'border border-dashed border-edge bg-transparent',
};

export const EvidenceChip: React.FC<EvidenceChipProps> = ({
  kind,
  label,
  href,
  className,
}) => {
  const displayLabel = label ?? DEFAULT_LABELS[kind];

  const commonClasses = cn(
    'inline-flex items-center gap-1.5 h-7 px-2.5 pl-2 rounded-[8px] text-[13px] font-semibold leading-none text-foreground whitespace-nowrap',
    KIND_CONTAINER_CLASSES[kind],
    href &&
      'relative before:content-[\'\'] before:absolute before:-inset-y-2 before:-inset-x-1.5 focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[3px] focus-visible:outline transition-colors duration-120 active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 hover:border-foreground',
    className
  );

  if (href) {
    return (
      <a href={href} className={commonClasses}>
        {renderGlyph(kind)}
        <span>{displayLabel}</span>
      </a>
    );
  }

  return (
    <span className={commonClasses}>
      {renderGlyph(kind)}
      <span>{displayLabel}</span>
    </span>
  );
};
