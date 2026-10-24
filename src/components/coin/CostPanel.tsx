'use client';

import React, { useMemo, useState } from 'react';
import { Panel } from '@/components/kit/Panel';
import { SegmentedControl, type SegmentedControlOption } from '@/components/kit/SegmentedControl';
import { StateNotice } from '@/components/kit/StateNotice';
import { useCostCheckMarket } from '@/hooks/useCostCheck';
import {
  DEFAULT_INPUTS,
  HOLD_PRESETS,
  computeCostCheck,
} from '@/lib/costs/cost-check-model';
import { cn } from '@/lib/utils';

export interface CostPanelProps {
  symbol: string;
  onHoldChange?: (holdMinutes: number) => void;
  className?: string;
}

const HOLD_OPTIONS: SegmentedControlOption[] = HOLD_PRESETS.map((p) => ({
  label: p.label,
  value: String(p.minutes),
}));

export const CostPanel: React.FC<CostPanelProps> = ({
  symbol,
  onHoldChange,
  className,
}) => {
  const [holdMinutes, setHoldMinutes] = useState<number>(60);

  const { data, isLoading, isError, refetch } = useCostCheckMarket(
    symbol,
    holdMinutes,
    1000
  );

  const handleHoldChange = (val: string) => {
    const nextMinutes = Number(val);
    setHoldMinutes(nextMinutes);
    onHoldChange?.(nextMinutes);
  };

  const model = useMemo(() => {
    if (!data) return null;
    try {
      return computeCostCheck(
        { ...DEFAULT_INPUTS, symbol, margin: 1000, leverage: 1, holdMinutes },
        data,
        data.asOf ?? 0
      );
    } catch {
      return null;
    }
  }, [data, symbol, holdMinutes]);

  const costPercent: number | undefined =
    (data as Record<string, unknown> | undefined)?.roundTripPercent as number | undefined ??
    (data as Record<string, unknown> | undefined)?.roundTripCostPercent as number | undefined ??
    (data as Record<string, unknown> | undefined)?.costPercent as number | undefined ??
    ((data as Record<string, unknown> | undefined)?.roundTrip as Record<string, unknown> | undefined)?.tradingPercent as number | undefined ??
    ((data as Record<string, unknown> | undefined)?.roundTrip as Record<string, unknown> | undefined)?.totalPercent as number | undefined ??
    model?.roundTrip.tradingPercent;

  const costDollars: number | undefined =
    (data as Record<string, unknown> | undefined)?.roundTripUsdt as number | undefined ??
    (data as Record<string, unknown> | undefined)?.roundTripCostUsdt as number | undefined ??
    (data as Record<string, unknown> | undefined)?.costDollars as number | undefined ??
    (data as Record<string, unknown> | undefined)?.costUsdt as number | undefined ??
    ((data as Record<string, unknown> | undefined)?.roundTrip as Record<string, unknown> | undefined)?.totalUsdt as number | undefined ??
    (costPercent !== undefined ? (1000 * costPercent) / 100 : undefined);

  const typicalMove: number | undefined =
    data?.move?.medianPercent ??
    ((data as Record<string, unknown> | undefined)?.typicalMove as number | undefined) ??
    ((data as Record<string, unknown> | undefined)?.typicalMovePercent as number | undefined);

  return (
    <Panel title="What a round trip costs" className={className}>
      <div className="space-y-4">
        <SegmentedControl
          legend="Hold"
          options={HOLD_OPTIONS}
          value={String(holdMinutes)}
          onChange={handleHoldChange}
        />

        {isLoading && !data ? (
          <StateNotice kind="loading" title="Loading costs." />
        ) : isError || !data ? (
          <StateNotice
            kind="error"
            title="Costs did not load."
            action={
              <button
                type="button"
                onClick={() => refetch()}
                className={cn(
                  'min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[12px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer',
                  'hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline transition-colors duration-120',
                  'active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100'
                )}
              >
                Try again
              </button>
            }
          />
        ) : (
          <div className="space-y-3 pt-1">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <span className="text-[14px] text-muted-foreground">Round-trip cost ($1,000)</span>
              <div className="flex items-baseline gap-2 font-sans tabular-nums font-semibold">
                <span className="text-[18px] text-foreground">
                  {costDollars !== undefined ? `$${costDollars.toFixed(2)}` : 'n/a'}
                </span>
                <span className="text-[14px] text-muted-foreground">
                  {costPercent !== undefined ? `(${costPercent.toFixed(2)}%)` : ''}
                </span>
              </div>
            </div>

            {typicalMove !== undefined && (
              <div className="flex items-baseline justify-between gap-3 flex-wrap border-t border-line pt-2.5">
                <span className="text-[14px] text-muted-foreground">Typical move</span>
                <span className="text-[15px] font-semibold text-foreground font-sans tabular-nums">
                  {typicalMove.toFixed(2)}%
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
};
