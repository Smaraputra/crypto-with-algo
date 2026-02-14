'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertCircle, Calendar, ChevronDown, ChevronRight, CheckCircle2, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { format } from 'date-fns';
import { TriggerOptimizationDialog } from './TriggerOptimizationDialog';

interface CronJobDetail {
  tradingStyle: string;
  symbol: string;
  interval: string;
  jobId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  activated: boolean;
  activationReason: string | null;
}

interface CronRunResponse {
  id: string;
  type: string;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: 'scheduled' | 'running' | 'completed' | 'failed';
  jobs: CronJobDetail[];
  summary: {
    totalJobs: number;
    completedJobs: number;
    failedJobs: number;
    activatedTemplates: number;
  };
  error: string | null;
  createdAt: string;
}

const statusColors = {
  scheduled: 'secondary',
  running: 'default',
  completed: 'success',
  failed: 'destructive',
} as const;

const jobStatusColors = {
  pending: 'secondary',
  running: 'default',
  completed: 'success',
  failed: 'destructive',
} as const;

export function CronHistory() {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: runs, isLoading, error } = useQuery<CronRunResponse[]>({
    queryKey: ['cron-runs'],
    queryFn: async () => {
      const res = await fetch('/api/admin/cron-runs');
      if (!res.ok) throw new Error('Failed to fetch cron run history');
      return res.json();
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const hasActive = data.some(
        (run) => run.status === 'running' || run.status === 'scheduled'
      );
      return hasActive ? 5000 : false;
    },
    refetchOnWindowFocus: false,
  });

  function toggleRow(id: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function formatDuration(startedAt: string | null, completedAt: string | null): string {
    if (!startedAt || !completedAt) return '-';
    const seconds = Math.round(
      (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
    );
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${minutes}m ${remaining}s`;
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>
          Failed to load cron run history: {(error as Error).message}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                Cron Run History
              </CardTitle>
              <CardDescription>
                View monthly optimization runs and their job details
              </CardDescription>
            </div>
            <Button onClick={() => setDialogOpen(true)}>
              Trigger Optimization
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!runs || runs.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Calendar className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No cron runs yet</p>
              <p className="text-sm mt-2">
                Trigger a monthly optimization or wait for the scheduled cron job
              </p>
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Jobs</TableHead>
                    <TableHead className="text-right">Activated</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => {
                    const isExpanded = expandedRows.has(run.id);
                    const progress = run.status === 'running'
                      ? `${run.summary.completedJobs + run.summary.failedJobs}/${run.summary.totalJobs}`
                      : `${run.summary.completedJobs}/${run.summary.totalJobs}`;

                    return (
                      <TableRow key={run.id} className="group">
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={() => toggleRow(run.id)}
                            aria-label={isExpanded ? 'Collapse row' : 'Expand row'}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </Button>
                        </TableCell>
                        <TableCell className="font-medium">
                          <div className="flex flex-col">
                            <span>{format(new Date(run.scheduledAt), 'MMM d, yyyy')}</span>
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(run.scheduledAt), 'h:mm a')}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusColors[run.status]}>
                            {run.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {progress}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {run.summary.activatedTemplates}
                        </TableCell>
                        <TableCell className="text-right">
                          {run.status === 'running'
                            ? 'Running...'
                            : formatDuration(run.startedAt, run.completedAt)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              {/* Expanded job details */}
              {runs.map((run) => {
                if (!expandedRows.has(run.id) || run.jobs.length === 0) return null;
                return (
                  <div key={`${run.id}-details`} className="border-t bg-muted/50 p-4">
                    <h4 className="text-sm font-medium mb-2">Job Details - {format(new Date(run.scheduledAt), 'MMM d, yyyy')}</h4>
                    <div className="rounded-md border bg-background">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Style</TableHead>
                            <TableHead>Symbol</TableHead>
                            <TableHead>Interval</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Activated</TableHead>
                            <TableHead>Error</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {run.jobs.map((job, idx) => (
                            <TableRow key={idx}>
                              <TableCell className="capitalize">
                                {job.tradingStyle.replace('_', ' ')}
                              </TableCell>
                              <TableCell className="font-mono">
                                {job.symbol || '-'}
                              </TableCell>
                              <TableCell className="font-mono">
                                {job.interval || '-'}
                              </TableCell>
                              <TableCell>
                                <Badge variant={jobStatusColors[job.status]}>
                                  {job.status}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                {job.activated ? (
                                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                                ) : (
                                  <span className="text-muted-foreground">-</span>
                                )}
                              </TableCell>
                              <TableCell className="max-w-[200px] truncate text-destructive">
                                {job.error || '-'}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {run.error && (
                      <p className="text-sm text-destructive mt-2">
                        Run error: {run.error}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <TriggerOptimizationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onTriggered={() => {
          // Dialog handles query invalidation internally
        }}
      />
    </>
  );
}
