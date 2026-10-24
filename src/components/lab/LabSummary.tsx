import React from 'react';
import { Panel } from '@/components/kit/Panel';
import { PriceFigure } from '@/components/kit/PriceFigure';
import { IdeaCells, type IdeaCellsCounts } from '@/components/kit/IdeaCells';
import { cn } from '@/lib/utils';

export interface LabSummaryProps {
  counts?: IdeaCellsCounts;
  isLoading?: boolean;
  className?: string;
}

const DEFAULT_SLOT_COUNT = 14;

export const LabSummary: React.FC<LabSummaryProps> = ({
  counts = { validated: 0, underTest: 0, rejected: 0, notStarted: 0 },
  isLoading = false,
  className,
}) => {
  if (isLoading) {
    const providedTotal =
      (counts.validated ?? 0) +
      (counts.underTest ?? 0) +
      (counts.rejected ?? 0) +
      (counts.notStarted ?? 0);
    const slotCount = providedTotal > 1 ? providedTotal : DEFAULT_SLOT_COUNT;
    const showNoValidatedSubline = (counts.validated ?? 0) === 0;

    return (
      <Panel className={cn('flex flex-col', className)}>
        <div className="flex flex-col">
          <span
            data-testid="summary-headline-skeleton"
            className="block h-[56px] w-64 rounded-[8px] bg-muted animate-pulse motion-reduce:animate-none"
            aria-hidden="true"
          />
        </div>
        {showNoValidatedSubline && (
          <p className="text-[14px] mt-2 leading-relaxed">
            <span
              data-testid="summary-subline-skeleton"
              className="inline-block h-5 w-52 rounded-[4px] bg-muted animate-pulse motion-reduce:animate-none"
              aria-hidden="true"
            />
          </p>
        )}
        <div className="mt-4">
          <div
            role="img"
            aria-label="Loading lab ideas"
            className="flex flex-wrap gap-1.5 select-none"
          >
            {Array.from({ length: slotCount }, (_, i) => (
              <span
                key={i}
                data-testid="idea-cell"
                data-kind="loading"
                aria-hidden="true"
                className="w-[26px] h-[26px] rounded-[8px] bg-muted animate-pulse motion-reduce:animate-none shrink-0"
              />
            ))}
          </div>
        </div>
        <p className="text-[14px] text-muted-foreground mt-4 leading-relaxed font-sans">
          Evidence is updated every hour at 20 minutes past.
        </p>
      </Panel>
    );
  }

  const validatedCount = counts.validated ?? 0;
  const headline = `${validatedCount} validated`;

  return (
    <Panel className={cn('flex flex-col', className)}>
      <PriceFigure value={headline} size="large" />
      {validatedCount === 0 && (
        <p className="text-[14px] text-muted-foreground mt-2 leading-relaxed">
          No idea has been validated yet.
        </p>
      )}
      <div className="mt-4">
        <IdeaCells counts={counts} />
      </div>
      <p className="text-[14px] text-muted-foreground mt-4 leading-relaxed font-sans">
        Evidence is updated every hour at 20 minutes past.
      </p>
    </Panel>
  );
};

