'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PortfolioSelector } from '@/components/portfolio/PortfolioSelector';
import { AnalyticsSummaryCards } from '@/components/analytics/AnalyticsSummaryCards';
import { CostBasisTable } from '@/components/analytics/CostBasisTable';
import { RiskMetricsCards } from '@/components/analytics/RiskMetricsCards';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePortfolios } from '@/hooks/usePortfolio';

const PortfolioValueChart = dynamic(
  () => import('@/components/analytics/PortfolioValueChart').then((m) => m.PortfolioValueChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-[300px] rounded-lg border border-border animate-shimmer" />
    ),
  }
);

export default function AnalyticsPage() {
  const { data } = usePortfolios();
  const [userSelectedId, setUserSelectedId] = useState<string | null>(null);

  const selectedId = useMemo(() => {
    if (userSelectedId) return userSelectedId;
    return data?.portfolios?.[0]?._id ?? null;
  }, [userSelectedId, data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Analytics</h1>
        <PortfolioSelector selectedId={selectedId} onSelect={setUserSelectedId} />
      </div>

      <Tabs defaultValue="overview" data-testid="analytics-tabs">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="cost-basis">Cost Basis</TabsTrigger>
          <TabsTrigger value="risk-metrics">Risk Metrics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <ErrorBoundary
            fallback={<p className="text-sm text-muted-foreground">Chart unavailable</p>}
          >
            <PortfolioValueChart portfolioId={selectedId} />
          </ErrorBoundary>
          <ErrorBoundary
            fallback={<p className="text-sm text-muted-foreground">Summary unavailable</p>}
          >
            <AnalyticsSummaryCards portfolioId={selectedId} range={30} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="cost-basis" className="space-y-4">
          <ErrorBoundary
            fallback={<p className="text-sm text-muted-foreground">Cost basis unavailable</p>}
          >
            <CostBasisTable portfolioId={selectedId} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="risk-metrics" className="space-y-4">
          <ErrorBoundary
            fallback={<p className="text-sm text-muted-foreground">Risk metrics unavailable</p>}
          >
            <RiskMetricsCards portfolioId={selectedId} range={90} />
          </ErrorBoundary>
        </TabsContent>
      </Tabs>
    </div>
  );
}
