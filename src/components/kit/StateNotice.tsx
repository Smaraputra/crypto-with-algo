import React from 'react';
import { cn } from '@/lib/utils';

export type StateNoticeKind = 'empty' | 'loading' | 'error';

export interface StateNoticeProps {
  kind: StateNoticeKind;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export const StateNotice: React.FC<StateNoticeProps> = ({
  kind,
  title,
  description,
  action,
  className,
}) => {
  const isStatus = kind === 'loading';
  const isAlert = kind === 'error';

  return (
    <div
      role={isStatus ? 'status' : isAlert ? 'alert' : undefined}
      aria-busy={isStatus ? true : undefined}
      className={cn('bg-card rounded-[14px] p-5 flex flex-col gap-3', className)}
    >
      <div className="space-y-1">
        <p className="text-[15px] font-semibold text-foreground leading-normal">{title}</p>
        {description && (
          <p className="text-[14px] text-muted-foreground leading-relaxed">{description}</p>
        )}
      </div>

      {isStatus && (
        <div className="flex flex-col gap-2.5 mt-1" aria-hidden="true" data-testid="skeleton-rows">
          <div className="grid grid-cols-[1fr_70px] gap-2.5 items-center">
            <div className="h-4 rounded-[6px] bg-muted" />
            <div className="h-4 rounded-[6px] bg-muted" />
          </div>
          <div className="grid grid-cols-[1fr_70px] gap-2.5 items-center">
            <div className="h-4 rounded-[6px] bg-muted" />
            <div className="h-4 rounded-[6px] bg-muted" />
          </div>
          <div className="grid grid-cols-[1fr_70px] gap-2.5 items-center">
            <div className="h-4 rounded-[6px] bg-muted" />
            <div className="h-4 rounded-[6px] bg-muted" />
          </div>
        </div>
      )}

      {!isStatus && action && <div className="mt-1">{action}</div>}
    </div>
  );
};
