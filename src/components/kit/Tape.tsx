import React from 'react';
import { cn } from '@/lib/utils';

export const TAPE_MAX_TICKS = 160;

export interface TapeBet {
  add: boolean;
}

export interface TapeProps {
  bets?: TapeBet[];
  betCount?: number;
  evidence: number;
  threshold: number;
  label?: string;
  className?: string;
}

export const Tape: React.FC<TapeProps> = ({
  bets,
  betCount,
  evidence,
  threshold,
  label,
  className,
}) => {
  const total = bets ? bets.length : (betCount ?? 0);
  const ratio = threshold > 0 ? Math.min(Math.max(0, evidence) / threshold, 1) : 0;
  const fillWidth = `${ratio * 100}%`;
  const ariaLabel =
    label ?? `${total} bets, evidence ${evidence.toFixed(1)} of ${threshold}`;

  const shown = Math.min(total, TAPE_MAX_TICKS);
  const offset = total - shown;

  const visibleBets = bets
    ? bets.slice(offset).map((bet, i) => ({
        id: `bet-${offset + i}`,
        add: bet.add,
      }))
    : null;

  const neutralTicks =
    bets === undefined && total > 0
      ? Array.from({ length: shown }, (_, i) => ({
          id: `bet-${offset + i}`,
        }))
      : null;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={cn('relative h-9 select-none', className)}
    >
      <div className="absolute left-0 right-[6px] bottom-[7px] flex items-end justify-end overflow-hidden gap-[3px]">
        {visibleBets
          ? visibleBets.map((bet) => (
              <span
                key={bet.id}
                data-testid="tape-tick"
                data-add={bet.add}
                className={cn(
                  'w-[3px] rounded-[1px] shrink-0',
                  bet.add
                    ? 'h-[18px] bg-foreground tape-tick-add'
                    : 'h-[8px] bg-muted-foreground tape-tick-not-add'
                )}
              />
            ))
          : neutralTicks
            ? neutralTicks.map((tick) => (
                <span
                  key={tick.id}
                  data-testid="tape-tick"
                  className={cn(
                    'w-[3px] rounded-[1px] shrink-0 h-[12px] bg-muted-foreground tape-tick-neutral'
                  )}
                />
              ))
            : null}
      </div>
      <div className="absolute left-0 right-0 bottom-[2px] h-[2px] bg-edge" />
      <span
        data-testid="tape-fill"
        className="absolute left-0 bottom-[1px] h-[4px] bg-brand-line z-10"
        style={{ width: fillWidth }}
      />
      <div className="absolute right-0 top-1 bottom-0 w-[3px] rounded-[2px] bg-foreground" />
    </div>
  );
};

