import React from 'react';
import { Panel } from '@/components/kit/Panel';
import { PriceFigure } from '@/components/kit/PriceFigure';
import { IdeaCells, type IdeaCellsCounts } from '@/components/kit/IdeaCells';
import { cn } from '@/lib/utils';

export interface LabSummaryProps {
  counts: IdeaCellsCounts;
  className?: string;
}

export const LabSummary: React.FC<LabSummaryProps> = ({
  counts,
  className,
}) => {
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
