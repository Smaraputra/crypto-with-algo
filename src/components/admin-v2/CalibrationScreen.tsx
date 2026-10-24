'use client';

import React, { useState } from 'react';
import { PageHeader } from '@/components/kit/PageHeader';
import { StateNotice } from '@/components/kit/StateNotice';
import { Button } from '@/components/ui/button';
import { AdminTabs } from './AdminTabs';
import {
  CalibrationFilters,
  type CalibrationFiltersState,
} from './CalibrationFilters';
import { CoverageLine } from './CoverageLine';
import { TierPanel } from './TierPanel';
import { ReliabilityPanel } from './ReliabilityPanel';
import { DistributionPanel } from './DistributionPanel';
import { CumulativePanel } from './CumulativePanel';
import { useCalibration } from '@/hooks/useCalibration';
import { cn } from '@/lib/utils';

export interface CalibrationScreenProps {
  className?: string;
}

export const CalibrationScreen: React.FC<CalibrationScreenProps> = ({ className }) => {
  const [filters, setFilters] = useState<CalibrationFiltersState>({
    style: 'day_trading',
    interval: '1h',
    source: 'composite',
    symbol: '',
    configVersion: '',
    overlapping: false,
  });

  const query = useCalibration({
    style: filters.style,
    interval: filters.interval,
    source: filters.source,
    symbol: filters.symbol || undefined,
    configVersion: filters.configVersion ? Number(filters.configVersion) : undefined,
    overlapping: filters.overlapping || undefined,
  });

  const isEmpty =
    query.data &&
    query.data.meta &&
    query.data.meta.statusCounts.resolved === 0;

  return (
    <div className={cn('space-y-4', className)}>
      {/* Rule 6: Not a backtest line under title */}
      <PageHeader
        title="Calibration"
        description="A record of live price score outcomes after costs. Not a backtest."
      />

      <AdminTabs currentPath="/admin/calibration" />

      <CalibrationFilters
        filters={filters}
        onChange={setFilters}
        availableConfigVersions={query.data?.meta.configVersions ?? []}
      />

      {query.isLoading && (
        <StateNotice kind="loading" title="Loading calibration..." />
      )}

      {query.isError && (
        <StateNotice
          kind="error"
          title="Calibration did not load."
          description={query.error?.message || 'Unable to retrieve calibration metrics.'}
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => query.refetch()}
              className="min-h-[44px] px-4 rounded-[12px] font-semibold"
            >
              Try again
            </Button>
          }
        />
      )}

      {query.data && isEmpty && (
        <StateNotice
          kind="empty"
          title="No resolved outcomes for this style, interval and source."
          description="Try selecting a different interval or trading style."
        />
      )}

      {query.data && !isEmpty && (
        <div className="space-y-6">
          <CoverageLine meta={query.data.meta} />

          {/* Desktop: tier panel full width first */}
          <div className="w-full">
            <TierPanel data={query.data.tiers} meta={query.data.meta} />
          </div>

          {/* Then two charts per row on desktop, stacked on phone */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ReliabilityPanel data={query.data.reliability} />
            <DistributionPanel data={query.data.distribution} />
            <div className="lg:col-span-2">
              <CumulativePanel data={query.data.cumulative} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
