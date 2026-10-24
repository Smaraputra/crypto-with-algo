'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ResearchEntry, ResearchStatus } from '@/content/research/catalog';
import { EvidenceChip, type EvidenceKind } from '@/components/kit/EvidenceChip';
import { getBaseAsset } from '@/components/market-home/formatters';
import { LabLiveState } from './LabLiveState';
import { cn } from '@/lib/utils';

export interface ResearchEntryCardProps {
  entry: ResearchEntry;
  className?: string;
}

export function getStatusChipConfig(status: ResearchStatus): {
  kind: EvidenceKind;
  label?: string;
} {
  switch (status) {
    case 'under-test':
      return { kind: 'under-test' };
    case 'rejected':
      return { kind: 'rejected' };
    case 'no-edge':
      return { kind: 'no-edge' };
    case 'not-registered':
      return { kind: 'untested', label: 'Not registered' };
    case 'void':
      return { kind: 'rejected', label: 'Void' };
    case 'descriptive':
      return { kind: 'context', label: 'Descriptive' };
    case 'validated':
      return { kind: 'validated' };
  }
}

export const ResearchEntryCard: React.FC<ResearchEntryCardProps> = ({
  entry,
  className,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const chipConfig = getStatusChipConfig(entry.status);
  const contentId = `entry-${entry.id}-content`;

  useEffect(() => {
    const syncHash = () => {
      if (typeof window !== 'undefined' && window.location.hash) {
        const targetId = window.location.hash.replace(/^#/, '');
        if (targetId === entry.id) {
          setIsOpen(true);
          requestAnimationFrame(() => {
            const el = document.getElementById(entry.id);
            el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        }
      }
    };
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, [entry.id]);

  return (
    <article
      id={entry.id}
      className={cn(
        'rounded-panel border border-edge bg-card transition-colors',
        className
      )}
    >
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full text-left p-5 sm:p-6 min-h-[44px] flex flex-col gap-2.5 rounded-panel cursor-pointer hover:bg-muted/40 transition-colors duration-120 focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline"
      >
        <div className="flex items-start justify-between gap-3 w-full">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <h3 className="text-[17px] font-semibold text-foreground leading-snug">
              {entry.name}
            </h3>
            <EvidenceChip kind={chipConfig.kind} label={chipConfig.label} />
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-0.5">
            <span className="text-[13px] text-muted-foreground font-sans tabular-nums whitespace-nowrap">
              {entry.period}
            </span>
            <svg
              aria-hidden="true"
              viewBox="0 0 12 12"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={cn(
                'text-muted-foreground transition-transform duration-120 motion-reduce:transition-none',
                isOpen && 'rotate-90'
              )}
            >
              <path d="M4 2l4 4-4 4" />
            </svg>
          </div>
        </div>
        <p className="text-[14px] text-muted-foreground leading-relaxed pr-6">
          {entry.summary}
        </p>
      </button>

      {isOpen && (
        <div
          id={contentId}
          className="px-5 pb-5 sm:px-6 sm:pb-6 pt-2 border-t border-line space-y-6"
        >
          {/* Steps */}
          <div>
            <h4 className="text-[14px] font-semibold text-foreground mb-2">
              Steps
            </h4>
            <ol className="list-decimal list-inside space-y-1.5 text-[14px] text-muted-foreground leading-relaxed">
              {entry.steps.map((step) => (
                <li key={step}>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>

          {/* Result */}
          <div>
            <h4 className="text-[14px] font-semibold text-foreground mb-2">
              Result
            </h4>
            <p className="text-[14px] text-muted-foreground leading-relaxed">
              {entry.result}
            </p>
            {entry.figures && entry.figures.length > 0 && (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-[14px] mt-3">
                {entry.figures.map((fig) => (
                  <div
                    key={fig.label}
                    className="flex justify-between items-baseline border-b border-line py-1.5"
                  >
                    <dt className="text-muted-foreground">{fig.label}</dt>
                    <dd className="font-semibold text-foreground font-sans tabular-nums text-right">
                      {fig.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>

          {/* Research */}
          {entry.research && entry.research.length > 0 && (
            <div>
              <h4 className="text-[14px] font-semibold text-foreground mb-2">
                Research
              </h4>
              <ul className="list-disc list-inside space-y-1.5 text-[14px] text-muted-foreground leading-relaxed">
                {entry.research.map((item) => (
                  <li key={item}>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* References */}
          {entry.references && entry.references.length > 0 && (
            <div>
              <h4 className="text-[14px] font-semibold text-foreground mb-2">
                References
              </h4>
              <ul className="space-y-2 text-[14px] text-muted-foreground">
                {entry.references.map((ref) => (
                  <li key={`${ref.label}-${ref.path ?? ''}-${ref.pr ?? ''}`} className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium text-foreground">
                      {ref.label}
                    </span>
                    {ref.path && (
                      <code className="px-1.5 py-0.5 rounded bg-muted text-[13px] text-muted-foreground font-sans break-all">
                        {ref.path}
                      </code>
                    )}
                    {ref.pr && (
                      <span className="text-[13px] text-muted-foreground font-sans tabular-nums">
                        PR #{ref.pr}
                      </span>
                    )}
                    {ref.date && (
                      <span className="text-[13px] text-muted-foreground font-sans tabular-nums">
                        {ref.date}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Open full page */}
          <div className="pt-2">
            <Link
              href={`/signals/${entry.id}`}
              className="inline-flex items-center min-h-[44px] px-3.5 py-2 text-[13px] font-semibold text-foreground rounded-[8px] bg-muted/60 hover:bg-muted hover:border-foreground border border-edge transition-colors duration-120 focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline"
            >
              Open the full page
            </Link>
          </div>

          {/* Coins */}
          {entry.symbols && entry.symbols.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line text-[14px]">
              <span className="font-medium text-foreground">Coins:</span>
              {entry.symbols.map((sym) => (
                <Link
                  key={sym}
                  href={`/focus?symbol=${encodeURIComponent(sym)}`}
                  className="inline-flex items-center min-h-[44px] px-3 py-1 text-[13px] font-semibold text-foreground rounded-[8px] bg-muted/60 hover:bg-muted hover:border-foreground border border-edge transition-colors duration-120 focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline"
                >
                  {getBaseAsset(sym)}
                </Link>
              ))}
            </div>
          )}

          {/* Live state */}
          {entry.labHypotheses && entry.labHypotheses.length > 0 && (
            <div className="pt-2 border-t border-line">
              <LabLiveState hypothesisIds={entry.labHypotheses} />
            </div>
          )}
        </div>
      )}
    </article>
  );
};
