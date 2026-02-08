'use client';

import dynamic from 'next/dynamic';

const DashboardChart = dynamic(
  () => import('./DashboardChart').then((m) => m.DashboardChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-[500px] rounded-lg border border-border animate-shimmer" />
    ),
  }
);

export function LazyDashboardChart() {
  return <DashboardChart />;
}
