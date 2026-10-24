'use client';

import React from 'react';
import { Panel } from '@/components/kit/Panel';
import { StateNotice } from '@/components/kit/StateNotice';
import {
  MIN_INDEPENDENT_WINDOWS,
  type CostCheckModel,
} from '@/lib/costs/cost-check-model';
import { COST_TONE_LABEL } from '@/lib/costs/verdict';
import type { CostCheckMarketResponse } from '@/types/cost-check';
import { cn } from '@/lib/utils';

export interface CostResultsProps {
  model: CostCheckModel;
  marketData: CostCheckMarketResponse | null;
  marketProblem: string | null;
  marketLoading: boolean;
  marketFetching: boolean;
  retryMarket: () => void;
  inputsValid?: boolean;
  className?: string;
}

function formatBps(v: number): string {
  if (v > 0 && v < 0.01) {
    return 'under 0.01 bps';
  }
  return `${v.toFixed(2)} bps`;
}

function formatUsd(v: number): string {
  if (v === 0) {
    return '$0.00';
  }
  const abs = Math.abs(v);
  if (abs > 0 && abs < 0.005) {
    return 'under $0.01';
  }
  return `$${abs.toFixed(2)}`;
}

function formatPct(v: number): string {
  if (v === 0) {
    return '0.00%';
  }
  const abs = Math.abs(v);
  if (abs > 0 && abs < 0.005) {
    return 'under 0.01%';
  }
  return `${abs.toFixed(2)}%`;
}

export const CostResults: React.FC<CostResultsProps> = ({
  model,
  marketData,
  marketProblem,
  marketLoading,
  marketFetching,
  retryMarket,
  inputsValid = true,
  className,
}) => {
  if (!inputsValid) {
    return (
      <Panel title="Cost results" className={className}>
        <p className="text-[14px] text-muted-foreground">
          Fix the highlighted inputs to see the costs.
        </p>
      </Panel>
    );
  }

  if (marketLoading && !marketData) {
    return (
      <Panel title="Cost results" className={className}>
        <StateNotice kind="loading" title="Loading market data." />
      </Panel>
    );
  }

  const { roundTrip } = model;
  const spreadBps =
    marketData?.slippage.halfSpreadBps !== null &&
    marketData?.slippage.halfSpreadBps !== undefined
      ? formatBps(marketData.slippage.halfSpreadBps * 2)
      : 'n/a';

  let slippageLabel = 'Fallback estimate';
  if (model.slippageForOtherSize) {
    slippageLabel = 'Measured for previous size';
  } else if (model.slippageSource === 'depth') {
    slippageLabel = `Order book depth (${formatBps(model.slippageBps)})`;
  } else if (model.slippageSource === 'fallback') {
    slippageLabel = `Fallback estimate (${formatBps(model.slippageBps)})`;
  } else if (model.slippageSource === 'override') {
    slippageLabel = `User override (${formatBps(model.slippageBps)})`;
  }

  return (
    <Panel
      title="Cost results"
      action={
        marketFetching ? (
          <span className="text-[12px] text-muted-foreground font-sans tabular-nums">
            Updating...
          </span>
        ) : null
      }
      className={cn('space-y-6', className)}
    >
      {marketProblem && !marketData && (
        <div
          role="alert"
          className="p-4 rounded-[12px] bg-muted/60 border border-line flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <p className="text-[14px] text-foreground">
            Live market data did not load: {marketProblem}. Slippage uses a flat {model.slippageBps} bps assumption and funding is not included.
          </p>
          <button
            type="button"
            onClick={retryMarket}
            className="min-h-[44px] h-[44px] px-4 shrink-0 inline-flex items-center justify-center rounded-[12px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring"
          >
            Try again
          </button>
        </div>
      )}

      {/* Focal number: Round-trip cost */}
      <div className="flex flex-col gap-1 border-b border-line pb-5">
        <span className="text-[13px] font-medium text-muted-foreground">
          Round-trip cost
        </span>
        <div className="flex items-baseline gap-3 flex-wrap">
          <span
            data-testid="focal-round-trip-cost"
            className="text-[56px] font-semibold font-sans tabular-nums leading-none text-foreground tracking-[-0.02em]"
          >
            {formatUsd(model.verdictCostUsdt)}
          </span>
          <span className="text-[18px] font-semibold text-muted-foreground font-sans tabular-nums">
            ({formatPct(model.verdictCostPercent)})
          </span>
        </div>

        {model.slippageForOtherSize && (
          <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] font-semibold bg-muted text-ink-2 w-fit">
            Measured for previous size
          </div>
        )}

        {model.belowMinNotional && (
          <p role="alert" className="mt-2 text-[13px] text-down font-medium">
            Position size is below the venue minimum of $
            {model.effectiveMinNotional !== null ? model.effectiveMinNotional.toFixed(2) : 'n/a'}
          </p>
        )}
      </div>

      {/* Verdict and typical move */}
      <div className="p-4 rounded-[12px] bg-muted/50 border border-line space-y-2">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-muted-foreground">Verdict</span>
          {model.verdict.kind === 'verdict' && (
            <span
              data-testid="cost-verdict-label"
              className="text-[16px] font-semibold text-foreground"
            >
              {COST_TONE_LABEL[model.verdict.tone]}
            </span>
          )}
        </div>

        {model.verdict.kind === 'thin' && (
          <p className="text-[14px] text-ink-2">
            Insufficient data for a verdict: {model.verdict.independentWindows} of {MIN_INDEPENDENT_WINDOWS} independent windows.
          </p>
        )}

        {model.verdict.kind === 'no-market' && (
          <p className="text-[14px] text-muted-foreground">
            No market move data available.
          </p>
        )}

        {model.move ? (
          <p className="text-[13px] text-muted-foreground font-sans tabular-nums">
            Average move over this hold: {model.move.meanPercent.toFixed(2)}% (median {model.move.medianPercent.toFixed(2)}%), from {model.move.samples.toLocaleString()} samples in {model.move.independentWindows} independent windows.
          </p>
        ) : (
          <p className="text-[13px] text-muted-foreground font-sans tabular-nums">
            Average move over this hold: n/a
          </p>
        )}
      </div>

      {/* Results breakdown */}
      <div className="space-y-3 pt-1">
        {/* Move needed to break even */}
        <div className="flex items-baseline justify-between gap-3 flex-wrap border-b border-line pb-2.5">
          <span className="text-[14px] text-muted-foreground">Move needed to break even</span>
          <div className="flex items-baseline gap-2 font-sans tabular-nums font-semibold text-right">
            <span className="text-[15px] text-foreground">
              {model.verdictCostPercent.toFixed(2)}%
            </span>
            {model.verdict.kind === 'verdict' && (
              <span className="text-[13px] text-muted-foreground font-normal">
                {model.verdict.breakeven.kind === 'possible'
                  ? `(${(model.verdict.breakeven.winRate * 100).toFixed(1)}% win rate needed)`
                  : '(costs exceed typical move)'}
              </span>
            )}
          </div>
        </div>

        {/* Funding over hold */}
        <div className="flex items-baseline justify-between gap-3 flex-wrap border-b border-line pb-2.5">
          <span className="text-[14px] text-muted-foreground">Funding over hold</span>
          <div className="flex items-baseline gap-2 font-sans tabular-nums font-semibold text-right">
            {!marketData ? (
              <span className="text-[15px] text-muted-foreground font-normal">n/a</span>
            ) : model.settlements === 0 ? (
              <span className="text-[15px] text-foreground font-semibold">No settlement in this hold</span>
            ) : (
              <>
                <span className="text-[15px] text-foreground font-semibold">
                  {roundTrip.fundingUsdt > 0
                    ? `You pay ${formatUsd(roundTrip.fundingUsdt)}`
                    : roundTrip.fundingUsdt < 0
                      ? `You receive ${formatUsd(roundTrip.fundingUsdt)}, not counted in the cost`
                      : '$0.00'}
                </span>
                <span className="text-[13px] text-muted-foreground font-normal">
                  ({model.settlements} settlement{model.settlements === 1 ? '' : 's'})
                </span>
              </>
            )}
          </div>
        </div>

        {/* Trading fees */}
        <div className="flex items-baseline justify-between gap-3 flex-wrap border-b border-line pb-2.5">
          <span className="text-[14px] text-muted-foreground">Trading fees</span>
          <div className="flex items-baseline gap-2 font-sans tabular-nums font-semibold text-right">
            <span className="text-[15px] text-foreground">
              {formatUsd(roundTrip.feeUsdt)}
            </span>
            <span className="text-[13px] text-muted-foreground font-normal">
              ({formatPct(roundTrip.feePercent)})
            </span>
          </div>
        </div>

        {/* Slippage */}
        <div className="flex items-baseline justify-between gap-3 flex-wrap border-b border-line pb-2.5">
          <div className="flex flex-col">
            <span className="text-[14px] text-muted-foreground">Slippage</span>
            <span className="text-[12px] text-muted-foreground">
              {slippageLabel}
              {marketData?.slippage.exceedsTopOfBook ? ' (exceeds book)' : ''}
            </span>
          </div>
          <div className="flex items-baseline gap-2 font-sans tabular-nums font-semibold text-right">
            <span className="text-[15px] text-foreground">
              {formatUsd(roundTrip.slippageUsdt)}
            </span>
            <span className="text-[13px] text-muted-foreground font-normal">
              ({formatPct(roundTrip.slippagePercent)})
            </span>
          </div>
        </div>

        {/* Market spread */}
        <div className="flex items-baseline justify-between gap-3 flex-wrap border-b border-line pb-2.5">
          <span className="text-[14px] text-muted-foreground">Market spread</span>
          <span className="text-[15px] font-semibold text-foreground font-sans tabular-nums">
            {spreadBps !== 'n/a' ? (
              spreadBps
            ) : (
              <span className="text-muted-foreground font-normal">n/a</span>
            )}
          </span>
        </div>

        {/* Position context metrics */}
        <div className="flex items-baseline justify-between gap-3 flex-wrap border-b border-line pb-2.5">
          <span className="text-[14px] text-muted-foreground">Cost share of margin</span>
          <span className="text-[15px] font-semibold text-foreground font-sans tabular-nums">
            {model.costPercentOfMargin.toFixed(2)}%
          </span>
        </div>

        <div className="flex items-baseline justify-between gap-3 flex-wrap border-b border-line pb-2.5">
          <span className="text-[14px] text-muted-foreground">Distance to liquidation</span>
          <span className="text-[15px] font-semibold text-foreground font-sans tabular-nums">
            {model.liquidationDistancePercent.toFixed(2)}%
          </span>
        </div>

        <div className="flex items-baseline justify-between gap-3 flex-wrap pt-1">
          <span className="text-[14px] text-muted-foreground">Monthly cost burn</span>
          <div className="flex items-baseline gap-2 font-sans tabular-nums font-semibold text-right">
            <span className="text-[15px] text-foreground">
              ${model.burn.perMonthUsdt.toFixed(2)}/mo
            </span>
            {model.burn.percentOfEquity !== null && (
              <span className="text-[13px] text-muted-foreground font-normal">
                ({model.burn.percentOfEquity.toFixed(1)}% of equity)
              </span>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
};
