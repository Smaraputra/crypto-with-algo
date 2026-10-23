import React from 'react';
import { Panel } from '@/components/kit/Panel';
import { EvidenceChip } from '@/components/kit/EvidenceChip';
import { V8_STATUS } from '@/lib/signals/v8-status';
import { cn } from '@/lib/utils';

export interface PriceScoreRecordProps {
  className?: string;
}

export const PriceScoreRecord: React.FC<PriceScoreRecordProps> = ({ className }) => {
  return (
    <Panel
      title="Price score"
      action={<EvidenceChip kind="no-edge" label="No edge (measured)" />}
      className={cn('flex flex-col', className)}
    >
      <p className="text-[14px] text-muted-foreground leading-relaxed">
        Measured on years of history and found no edge after costs. Shown elsewhere as context only.
      </p>

      <details className="group mt-3 text-[13px] text-muted-foreground">
        <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer font-medium hover:text-foreground inline-flex items-center min-h-[44px] py-1 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          <svg
            aria-hidden="true"
            viewBox="0 0 12 12"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mr-1.5 shrink-0 transition-transform duration-120 group-open:rotate-90 motion-reduce:transition-none"
          >
            <path d="M4 2l4 4-4 4" />
          </svg>
          What was measured
        </summary>
        <div className="space-y-3 pt-2 mt-1 border-t border-line">
          {V8_STATUS.studies.map((study) => (
            <div key={study.name} className="space-y-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold text-foreground text-[14px]">{study.name}</span>
                <span className="text-[12px] text-muted-foreground font-sans tabular-nums">{study.date}</span>
              </div>
              <p className="text-[13px] text-muted-foreground leading-relaxed">{study.verdict}</p>
            </div>
          ))}
        </div>
      </details>
    </Panel>
  );
};
