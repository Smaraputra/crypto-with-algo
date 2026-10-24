import React from 'react';
import { EvidenceChip } from '@/components/kit/EvidenceChip';
import type { ViewTally } from '@/lib/signals/track-record/chart-data';
import { cn } from '@/lib/utils';

export interface CallsLegendProps {
  show: boolean;
  onShowChange: (next: boolean) => void;
  eligible: boolean;
  ineligibleReason: 'symbol' | 'interval' | null;
  tally: ViewTally | null;
  error: boolean;
  /** describeCall text for the call under the crosshair, or null. */
  hoverText: string | null;
  className?: string;
}

export const CallsLegend: React.FC<CallsLegendProps> = ({
  show,
  onShowChange,
  eligible,
  ineligibleReason,
  tally,
  error,
  hoverText,
  className,
}) => {
  let statusText: string | null = null;
  if (hoverText) {
    statusText = hoverText;
  } else if (error) {
    statusText = 'Past calls did not load.';
  } else if (tally) {
    if (tally.calls === 0) {
      statusText = 'No calls in view.';
    } else {
      const callsPart = tally.calls === 1 ? '1 call' : `${tally.calls} calls`;
      statusText = `In view: ${callsPart}, ${tally.won} won after costs, ${tally.cost} eaten by costs, ${tally.wrong} wrong way, ${tally.pending} pending.`;
    }
  }

  return (
    <div className={cn('flex flex-col gap-2.5 text-[13px]', className)}>
      <div className="flex items-center justify-between gap-2.5 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold text-foreground">Price score calls</span>
          <EvidenceChip kind="no-edge" />
        </div>
        {eligible && (
          <button
            type="button"
            role="switch"
            aria-checked={show}
            onClick={() => onShowChange(!show)}
            className={cn(
              'min-h-[44px] h-[44px] px-3.5 inline-flex items-center justify-center rounded-[12px] border text-[14px] font-semibold cursor-pointer select-none transition-colors duration-120 active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100',
              'focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px]',
              show
                ? 'bg-foreground text-background border-foreground'
                : 'bg-card text-ink-2 border-edge hover:bg-muted hover:text-foreground'
            )}
          >
            Show calls
          </button>
        )}
      </div>

      {!eligible ? (
        <div className="text-muted-foreground">
          {ineligibleReason === 'symbol'
            ? 'Calls are recorded for the ten signal coins only.'
            : 'Calls are not recorded at this interval.'}
        </div>
      ) : !show ? (
        <div className="text-muted-foreground">Calls are hidden.</div>
      ) : (
        <>
          <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap">
            <span className="text-muted-foreground">
              Buy call under the bar, sell call over it.
            </span>
            <span className="inline-flex items-center gap-1.5 text-foreground">
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                aria-hidden="true"
                className="w-2.5 h-2.5 shrink-0 fill-up"
              >
                <path d="M5 1L9 9H1Z" />
              </svg>
              <span>Won after costs</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-foreground">
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                aria-hidden="true"
                className="w-2.5 h-2.5 shrink-0 fill-muted-foreground"
              >
                <path d="M5 1L9 9H1Z" />
              </svg>
              <span>Right, costs ate it</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-foreground">
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                aria-hidden="true"
                className="w-2.5 h-2.5 shrink-0 fill-down"
              >
                <path d="M5 1L9 9H1Z" />
              </svg>
              <span>Wrong way</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-foreground">
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                aria-hidden="true"
                className="w-2.5 h-2.5 shrink-0 fill-none stroke-foreground"
              >
                <path d="M5 1.5L8.5 8.5H1.5Z" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
              <span>Pending</span>
            </span>
          </div>

          <div className="min-h-[20px] text-muted-foreground">
            {statusText}
          </div>
        </>
      )}
    </div>
  );
};
