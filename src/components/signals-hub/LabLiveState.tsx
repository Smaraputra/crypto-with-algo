'use client';

import React, { useMemo } from 'react';
import Link from 'next/link';
import { useSignalLab } from '@/hooks/useSignalLab';
import { useSignalLabV2 } from '@/hooks/useSignalLabV2';
import { useSignalLabV3 } from '@/hooks/useSignalLabV3';
import { useSignalLabV4 } from '@/hooks/useSignalLabV4';
import { cn } from '@/lib/utils';

export interface LabLiveStateProps {
  hypothesisIds: string[];
  className?: string;
}

interface GenericHypothesis {
  id: string;
  status: string;
  underTestSince: string | null;
  e: number;
  threshold: number;
  betBars: number;
}

function formatStatus(status: string): string {
  if (status === 'under_test') return 'Under test';
  if (status === 'validated') return 'Validated';
  if (status === 'not_started') return 'Not started';
  return status.replace(/_/g, ' ');
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().split('T')[0];
  } catch {
    return iso;
  }
}

export const LabLiveState: React.FC<LabLiveStateProps> = ({
  hypothesisIds,
  className,
}) => {
  const lab1 = useSignalLab();
  const lab2 = useSignalLabV2();
  const lab3 = useSignalLabV3();
  const lab4 = useSignalLabV4();

  const isLoading =
    lab1.isLoading || lab2.isLoading || lab3.isLoading || lab4.isLoading;
  const isError =
    lab1.isError || lab2.isError || lab3.isError || lab4.isError;

  const handleRetry = () => {
    lab1.refetch();
    lab2.refetch();
    lab3.refetch();
    lab4.refetch();
  };

  const hypothesisMap = useMemo(() => {
    const map = new Map<string, GenericHypothesis>();
    const ingest = (list?: GenericHypothesis[]) => {
      if (Array.isArray(list)) {
        for (const h of list) {
          if (h && typeof h.id === 'string') {
            map.set(h.id, h);
          }
        }
      }
    };
    ingest(lab1.data?.hypotheses as GenericHypothesis[] | undefined);
    ingest(lab2.data?.hypotheses as GenericHypothesis[] | undefined);
    ingest(lab3.data?.hypotheses as GenericHypothesis[] | undefined);
    ingest(lab4.data?.hypotheses as GenericHypothesis[] | undefined);
    return map;
  }, [lab1.data, lab2.data, lab3.data, lab4.data]);

  if (!hypothesisIds || hypothesisIds.length === 0) {
    return null;
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[14px] font-semibold text-foreground">Live state</h4>
        <Link
          href="/lab"
          className="inline-flex items-center min-h-[44px] text-[13px] font-semibold text-foreground hover:underline focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline"
        >
          Open the lab record
        </Link>
      </div>

      {isError ? (
        <div className="space-y-2.5 py-1" role="alert">
          <p className="text-[14px] text-muted-foreground">Live state did not load.</p>
          <button
            type="button"
            onClick={handleRetry}
            className="min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[10px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline transition-colors duration-120 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            Try again
          </button>
        </div>
      ) : isLoading ? (
        <div
          data-testid="lab-loading-skeleton"
          className="space-y-2 py-1"
          aria-busy="true"
        >
          {hypothesisIds.map((id) => (
            <div
              key={id}
              data-testid="lab-placeholder-row"
              className="h-10 w-full rounded-[6px] bg-muted animate-pulse motion-reduce:animate-none"
            />
          ))}
        </div>
      ) : (
        <div className="space-y-1.5 border-t border-line pt-1">
          {hypothesisIds.map((id) => {
            const h = hypothesisMap.get(id);

            if (!h) {
              return (
                <div
                  key={id}
                  data-testid="lab-hypothesis-row"
                  className="flex items-center justify-between py-2 border-b border-line text-[14px]"
                >
                  <span className="font-semibold text-foreground font-sans tabular-nums">
                    {id}
                  </span>
                  <span className="text-muted-foreground text-[13px]">
                    n/a
                  </span>
                </div>
              );
            }

            const statusText = formatStatus(h.status);
            const sinceText =
              h.underTestSince && h.status !== 'not_started'
                ? `since ${formatDate(h.underTestSince)}`
                : 'not started';

            return (
              <div
                key={id}
                data-testid="lab-hypothesis-row"
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 border-b border-line text-[14px]"
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground font-sans tabular-nums">
                    {id}
                  </span>
                  <span className="text-[13px] text-ink-2 font-medium">
                    {statusText}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-muted-foreground font-sans tabular-nums">
                  <span>
                    Evidence {h.e.toFixed(2)} of {h.threshold}, {h.betBars === 1 ? '1 bet' : `${h.betBars} bets`}, {sinceText}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
