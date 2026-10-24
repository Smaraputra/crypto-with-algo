'use client';

import { useEffect } from 'react';
import { RouteError } from '@/components/kit';

export default function PortfolioError({
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
      title="Portfolio did not load."
      reset={reset}
      digest={error.digest}
    />
  );
}
