'use client';

import React from 'react';
import { Panel } from '@/components/kit/Panel';
import { EvidenceChip } from '@/components/kit/EvidenceChip';
import { StateNotice } from '@/components/kit/StateNotice';
import { REGIME_EVIDENCE, type VolatilityRegime } from '@/lib/costs/volatility-regime';
import { cn } from '@/lib/utils';

export interface VolatilityRegimeNoteProps {
  regime: {
    data: VolatilityRegime | null | undefined;
    isLoading: boolean;
    problem: string | null;
    retry: () => void;
  };
  className?: string;
}

export const VolatilityRegimeNote: React.FC<VolatilityRegimeNoteProps> = ({
  regime,
  className,
}) => {
  return (
    <Panel
      title="Volatility regime"
      action={<EvidenceChip kind="context" />}
      className={cn('space-y-4', className)}
    >
      {regime.isLoading ? (
        <StateNotice kind="loading" title="Loading volatility regime." />
      ) : regime.problem ? (
        <StateNotice
          kind="error"
          title="Volatility regime did not load."
          description={`Regime data did not load: ${regime.problem}.`}
          action={
            <button
              type="button"
              onClick={regime.retry}
              className="min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[10px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring"
            >
              Try again
            </button>
          }
        />
      ) : !regime.data ? (
        <p className="text-[14px] text-muted-foreground">
          Volatility regime data is incomplete.
        </p>
      ) : (
        <div className="space-y-3.5">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <span className="text-[16px] font-semibold text-foreground">
              {regime.data.high ? 'High volatility regime' : 'Normal volatility regime'}
            </span>
            <div className="text-[14px] text-muted-foreground font-sans tabular-nums">
              Realised vol: {regime.data.dayVolPercent.toFixed(2)}% (threshold: {regime.data.thresholdVolPercent.toFixed(2)}%)
            </div>
          </div>

          <p className="text-[14px] text-ink-2 leading-relaxed">
            Measured on {regime.data.symbol}. Realised volatility over the last complete day ranked at the {regime.data.percentile.toFixed(0)}th percentile of its trailing {regime.data.trailingDays} days.
            {regime.data.high
              ? ' A high day indicates a higher probability of an active move tomorrow.'
              : ' Realised volatility remains within normal historical bounds.'}
          </p>

          <div className="border-t border-line pt-3 text-[13px] text-muted-foreground leading-relaxed">
            Evidence ({REGIME_EVIDENCE.symbol}, {REGIME_EVIDENCE.from} to {REGIME_EVIDENCE.to}, {REGIME_EVIDENCE.days.toLocaleString()} days): after a high day the next day was also high on {(REGIME_EVIDENCE.highAfterHigh * 100).toFixed(1)}% of days, compared to {(REGIME_EVIDENCE.highAfterOther * 100).toFixed(1)}% after other days ({(REGIME_EVIDENCE.highOnAnyDay * 100).toFixed(1)}% on any day). Measures move magnitude, never direction.
          </div>
        </div>
      )}
    </Panel>
  );
};
