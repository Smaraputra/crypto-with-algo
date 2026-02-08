'use client';

import { useMemo, useState } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PortfolioSelector } from '@/components/portfolio/PortfolioSelector';
import { PortfolioSummary } from '@/components/portfolio/PortfolioSummary';
import { usePortfolios } from '@/hooks/usePortfolio';

export default function PortfolioPage() {
  const { data } = usePortfolios();
  const [userSelectedId, setUserSelectedId] = useState<string | null>(null);

  const selectedId = useMemo(() => {
    if (userSelectedId) return userSelectedId;
    return data?.portfolios?.[0]?._id ?? null;
  }, [userSelectedId, data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Portfolio</h1>
        <PortfolioSelector selectedId={selectedId} onSelect={setUserSelectedId} />
      </div>
      <ErrorBoundary
        fallback={
          <p className="text-sm text-muted-foreground">
            Portfolio summary unavailable
          </p>
        }
      >
        <PortfolioSummary portfolioId={selectedId} />
      </ErrorBoundary>
    </div>
  );
}
