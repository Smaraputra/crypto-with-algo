'use client';

import { useCallback, useMemo } from 'react';
import { useSignalLab } from '@/hooks/useSignalLab';
import { useSignalLabV2 } from '@/hooks/useSignalLabV2';
import { useSignalLabV3 } from '@/hooks/useSignalLabV3';
import { useSignalLabV4 } from '@/hooks/useSignalLabV4';
import type { IdeaCellsCounts } from '@/components/kit/IdeaCells';

export interface LabSummaryResult {
  counts: IdeaCellsCounts;
  isLoading: boolean;
  isError: boolean;
  refetchFailed: () => void;
}

export function useLabSummary(): LabSummaryResult {
  const lab1 = useSignalLab();
  const lab2 = useSignalLabV2();
  const lab3 = useSignalLabV3();
  const lab4 = useSignalLabV4();

  const isLoading = lab1.isLoading || lab2.isLoading || lab3.isLoading || lab4.isLoading;
  const isError = lab1.isError || lab2.isError || lab3.isError || lab4.isError;

  const refetchFailed = useCallback(() => {
    if (lab1.isError) void lab1.refetch();
    if (lab2.isError) void lab2.refetch();
    if (lab3.isError) void lab3.refetch();
    if (lab4.isError) void lab4.refetch();
  }, [lab1, lab2, lab3, lab4]);

  const counts = useMemo<IdeaCellsCounts>(() => {
    let underTest = 0;
    let validated = 0;
    let notStarted = 0;
    const rejected = 1;

    const allHypotheses = [
      ...(lab1.data?.hypotheses ?? []),
      ...(lab2.data?.hypotheses ?? []),
      ...(lab3.data?.hypotheses ?? []),
      ...(lab4.data?.hypotheses ?? []),
    ];

    for (const h of allHypotheses) {
      if (h.status === 'under_test') {
        underTest += 1;
      } else if (h.status === 'validated') {
        validated += 1;
      } else if (h.status === 'not_started') {
        notStarted += 1;
      }
    }

    return {
      underTest,
      rejected,
      validated,
      notStarted,
    };
  }, [lab1.data, lab2.data, lab3.data, lab4.data]);

  return {
    counts,
    isLoading,
    isError,
    refetchFailed,
  };
}
