'use client';

import dynamic from 'next/dynamic';

const DashboardChart = dynamic(
  () => import('./DashboardChart').then((m) => m.DashboardChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-[560px] rounded-lg sm:h-[640px] border border-border animate-shimmer" />
    ),
  }
);

export function LazyDashboardChart() {
  return <DashboardChart />;
}
