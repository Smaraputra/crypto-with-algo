'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertList } from '@/components/alerts/AlertList';
import { CreateAlertForm } from '@/components/alerts/CreateAlertForm';
import { useAlerts } from '@/hooks/useAlerts';

const FILTER_TABS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'triggered', label: 'Triggered' },
  { value: 'paused', label: 'Paused' },
] as const;

export default function AlertsPage() {
  const [formOpen, setFormOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const { data, isLoading } = useAlerts(statusFilter || undefined);

  const alerts = data?.alerts ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Alerts</h1>
        <Button size="sm" onClick={() => setFormOpen(true)}>
          <Plus className="mr-1 size-4" />
          Create Alert
        </Button>
      </div>

      <Tabs
        value={statusFilter}
        onValueChange={setStatusFilter}
      >
        <TabsList>
          {FILTER_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <ErrorBoundary
        fallback={
          <p className="text-sm text-muted-foreground">
            Alert list unavailable
          </p>
        }
      >
        <AlertList alerts={alerts} isLoading={isLoading} />
      </ErrorBoundary>

      <CreateAlertForm open={formOpen} onOpenChange={setFormOpen} />
    </div>
  );
}
