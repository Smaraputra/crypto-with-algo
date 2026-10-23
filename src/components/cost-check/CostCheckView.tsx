'use client';

import { useCostCheckState } from '@/hooks/useCostCheckState';
import { CostCheckForm } from './CostCheckForm';
import { CostCheckResult } from './CostCheckResult';
import { CostCheckSummaryBar } from './CostCheckSummaryBar';
import { VolatilityRegimeCard } from './VolatilityRegimeCard';

export function CostCheckView() {
  const {
    inputs,
    updateInputs,
    model,
    marketData,
    marketProblem,
    marketLoading,
    marketFetching,
    measuredSlippageBps,
    symbols,
    regime,
  } = useCostCheckState();

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <CostCheckForm
          inputs={inputs}
          onChange={updateInputs}
          symbols={symbols.list}
          symbolsLoading={symbols.isLoading}
          symbolsError={symbols.isError}
          measuredSlippageBps={measuredSlippageBps}
        />
        <div className="space-y-4">
          <CostCheckResult
            inputs={inputs}
            model={model}
            market={marketData}
            marketProblem={marketProblem}
            isFetching={marketFetching}
            isLoading={marketLoading}
          />
          <VolatilityRegimeCard
            regime={regime.data}
            isLoading={regime.isLoading}
            problem={regime.problem}
          />
        </div>
      </div>
      <CostCheckSummaryBar model={model} />
    </div>
  );
}
