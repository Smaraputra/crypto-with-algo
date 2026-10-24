'use client';

import React, { useState } from 'react';
import { PageHeader } from '@/components/kit/PageHeader';
import {
  SegmentedControl,
  type SegmentedControlOption,
} from '@/components/kit/SegmentedControl';
import { Button } from '@/components/ui/button';
import { useAlerts } from '@/hooks/useAlerts';
import { AlertList } from './AlertList';
import { AlertSheet } from './AlertSheet';
import { cn } from '@/lib/utils';

export const STATUS_OPTIONS: SegmentedControlOption[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'triggered', label: 'Triggered' },
  { value: 'paused', label: 'Paused' },
];

export interface AlertsScreenProps {
  className?: string;
}

export const AlertsScreen: React.FC<AlertsScreenProps> = ({ className }) => {
  const [statusFilter, setStatusFilter] = useState('all');
  const [sheetOpen, setSheetOpen] = useState(false);

  const queryStatus = statusFilter === 'all' ? undefined : statusFilter;
  const { data, isLoading, isError, refetch } = useAlerts(queryStatus);

  return (
    <div className={cn('space-y-4', className)}>
      <PageHeader
        title="Alerts"
        actions={
          <Button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-5"
          >
            New alert
          </Button>
        }
      />

      <div className="flex items-center">
        <SegmentedControl
          legend="Show"
          value={statusFilter}
          onChange={setStatusFilter}
          options={STATUS_OPTIONS}
        />
      </div>

      <AlertList
        alerts={data?.alerts}
        isLoading={isLoading}
        isError={isError}
        onRefetch={() => refetch()}
      />

      <AlertSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  );
};
