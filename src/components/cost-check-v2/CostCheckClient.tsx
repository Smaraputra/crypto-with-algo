'use client';

import React from 'react';
import dynamic from 'next/dynamic';

const CostCheckScreen = dynamic(
  () => import('./CostCheckScreen').then((m) => m.CostCheckScreen),
  {
    ssr: false,
    loading: () => (
      <div
        className="space-y-4 pb-28 lg:pb-8"
        data-testid="cost-check-loading-placeholder"
        aria-busy="true"
      >
        <div className="space-y-2">
          <div className="h-8 w-44 rounded-[8px] bg-muted animate-pulse" />
          <div className="h-4 w-96 max-w-full rounded-[6px] bg-muted animate-pulse" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 h-[560px] rounded-panel bg-card border border-line animate-pulse" />
          <div className="lg:col-span-7 space-y-4">
            <div className="h-[420px] rounded-panel bg-card border border-line animate-pulse" />
            <div className="h-[200px] rounded-panel bg-card border border-line animate-pulse" />
          </div>
        </div>
      </div>
    ),
  }
);

export function CostCheckClient() {
  return <CostCheckScreen />;
}
