'use client';

import { useState } from 'react';
import { OptimizationForm } from './OptimizationForm';
import { OptimizationProgress } from './OptimizationProgress';
import { OptimizationHistory } from './OptimizationHistory';
import { CronHistory } from './CronHistory';
import { TemplateComparison } from './TemplateComparison';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { TradingStyle } from '@/lib/models/signal-template';

export function OptimizationDashboard() {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [comparisonTemplateId, setComparisonTemplateId] = useState<string | null>(null);

  const handleOptimizationStarted = (jobId: string) => {
    setActiveJobId(jobId);
  };

  const handleViewComparison = (templateId: string) => {
    setComparisonTemplateId(templateId);
  };

  return (
    <div className="space-y-6">
      {/* Active optimization progress */}
      {activeJobId && (
        <OptimizationProgress
          jobId={activeJobId}
          onComplete={() => setActiveJobId(null)}
        />
      )}

      <Tabs defaultValue="optimize" className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="optimize">New Optimization</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="cron">Cron Runs</TabsTrigger>
          <TabsTrigger value="compare">Compare Templates</TabsTrigger>
        </TabsList>

        <TabsContent value="optimize" className="space-y-4">
          <OptimizationForm
            onOptimizationStarted={handleOptimizationStarted}
            disabled={!!activeJobId}
          />
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          <OptimizationHistory
            onViewComparison={handleViewComparison}
          />
        </TabsContent>

        <TabsContent value="cron" className="space-y-4">
          <CronHistory />
        </TabsContent>

        <TabsContent value="compare" className="space-y-4">
          {comparisonTemplateId ? (
            <TemplateComparison templateId={comparisonTemplateId} />
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <p>Select a completed optimization from the History tab to compare templates</p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
