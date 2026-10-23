'use client';

import React from 'react';
import Link from 'next/link';
import { Panel } from '@/components/kit/Panel';
import { EvidenceChip } from '@/components/kit/EvidenceChip';
import { StateNotice } from '@/components/kit/StateNotice';
import { useUIStore } from '@/stores/uiStore';
import { useLatestSignalForStyle } from '@/hooks/useSignals';
import { tierDisplayLabel } from '@/lib/signals/tier-labels';
import { cn } from '@/lib/utils';
import { getBaseAsset } from './formatters';

export interface PriceScoreGlanceProps {
  symbol?: string;
  className?: string;
}

export const PriceScoreGlance: React.FC<PriceScoreGlanceProps> = ({
  symbol: propSymbol,
  className,
}) => {
  const storeSymbol = useUIStore((s) => s.selectedSymbol);
  const symbol = propSymbol ?? storeSymbol;
  const base = getBaseAsset(symbol);

  const { data, isLoading, isError } = useLatestSignalForStyle(
    symbol,
    'day_trading',
    '1h'
  );

  const actionChip = <EvidenceChip kind="no-edge" label="No edge (measured)" />;

  if (isError) {
    return (
      <Panel title="Price score" action={actionChip} className={className}>
        <StateNotice kind="error" title="The score did not load." />
      </Panel>
    );
  }

  if (isLoading) {
    return (
      <Panel title="Price score" action={actionChip} className={className}>
        <StateNotice kind="loading" title="Loading the score." />
      </Panel>
    );
  }

  const signal = data?.signal;

  if (!signal) {
    return (
      <Panel
        title="Price score"
        action={actionChip}
        className={cn('flex flex-col', className)}
      >
        <p className="text-[14px] text-muted-foreground">
          No score for this coin yet.
        </p>
        <div className="mt-4 pt-1">
          <Link
            href="/signals"
            className={cn(
              'min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[10px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer',
              'hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline transition-colors duration-120',
              'active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100'
            )}
          >
            Score detail
          </Link>
        </div>
      </Panel>
    );
  }

  const tierLabel = tierDisplayLabel(signal.tier);

  return (
    <Panel
      title="Price score"
      action={actionChip}
      className={cn('flex flex-col', className)}
    >
      <p className="text-[15px] font-semibold text-foreground leading-normal">
        {base}, 1 hour: {tierLabel}.
      </p>

      <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
        Measured on years of history and found no edge after costs. Context only.
      </p>

      <div className="mt-4 pt-1">
        <Link
          href="/signals"
          className={cn(
            'min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[10px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer',
            'hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline transition-colors duration-120',
            'active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100'
          )}
        >
          Score detail
        </Link>
      </div>
    </Panel>
  );
};
