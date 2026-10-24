'use client';

import React from 'react';
import { PageHeader } from '@/components/kit/PageHeader';
import { useCostCheckState } from '@/hooks/useCostCheckState';
import { costCheckInputsSchema } from '@/lib/costs/cost-check-model';
import { CostInputs } from './CostInputs';
import { CostResults } from './CostResults';
import { VolatilityRegimeNote } from './VolatilityRegimeNote';
import { cn } from '@/lib/utils';

export interface CostCheckScreenProps {
  className?: string;
}

export const CostCheckScreen: React.FC<CostCheckScreenProps> = ({ className }) => {
  const {
    inputs,
    updateInputs,
    model,
    marketData,
    marketProblem,
    marketLoading,
    marketFetching,
    retryMarket,
    symbols,
    regime,
  } = useCostCheckState();

  const isInitialLoading = marketLoading && !marketData;
  const inputsValid = costCheckInputsSchema.safeParse(inputs).success;

  return (
    <div className={cn('space-y-4 pb-28 lg:pb-8', className)}>
      <PageHeader
        title="Cost Check"
        description="What a round trip costs on your own position, before you place it."
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Desktop left, phone first: Inputs */}
        <div className="lg:col-span-5">
          <CostInputs
            inputs={inputs}
            updateInputs={updateInputs}
            symbols={symbols}
          />
        </div>

        {/* Desktop right, phone second: Results & Regime */}
        <div className="lg:col-span-7 space-y-4">
          <CostResults
            model={model}
            marketData={marketData}
            marketProblem={marketProblem}
            marketLoading={marketLoading}
            marketFetching={marketFetching}
            retryMarket={retryMarket}
            inputsValid={inputsValid}
          />

          <VolatilityRegimeNote regime={regime} />
        </div>
      </div>

      {/* Phone sticky bottom summary */}
      <div
        data-testid="phone-sticky-summary"
        className="fixed inset-x-0 bottom-[calc(72px+env(safe-area-inset-bottom,0px))] z-30 border-t border-line bg-card px-4 py-3 lg:hidden"
      >
        <div className="flex items-center justify-between gap-4 max-w-md mx-auto">
          <div className="flex flex-col">
            <span className="text-[12px] text-muted-foreground font-medium">Round trip</span>
            <span className="text-[16px] font-semibold text-foreground font-sans tabular-nums">
              {!inputsValid ? (
                <span className="text-muted-foreground font-normal">n/a</span>
              ) : isInitialLoading ? (
                <span
                  data-testid="sticky-round-trip-skeleton"
                  className="inline-block h-5 w-24 rounded-[4px] bg-muted animate-pulse motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                `$${model.verdictCostUsdt.toFixed(2)} (${model.verdictCostPercent.toFixed(2)}%)`
              )}
            </span>
          </div>

          <div className="flex flex-col items-end">
            <span className="text-[12px] text-muted-foreground font-medium">Move needed</span>
            <span className="text-[16px] font-semibold text-foreground font-sans tabular-nums">
              {!inputsValid ? (
                <span className="text-muted-foreground font-normal">n/a</span>
              ) : isInitialLoading ? (
                <span
                  data-testid="sticky-move-needed-skeleton"
                  className="inline-block h-5 w-14 rounded-[4px] bg-muted animate-pulse motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                `${model.verdictCostPercent.toFixed(2)}%`
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
