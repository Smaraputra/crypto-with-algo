'use client';

import { useEffect } from 'react';
import { RouteError } from '@/components/kit';

export default function BacktestError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <RouteError
      title="Backtest did not load."
      reset={reset}
      digest={error.digest}
    />
  );
}
