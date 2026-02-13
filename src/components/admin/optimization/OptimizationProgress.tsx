'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatDistanceToNow } from 'date-fns';

interface OptimizationProgressProps {
  jobId: string;
  onComplete?: () => void;
}

interface JobStatus {
  job: {
    id: string;
    tradingStyle: string;
    symbol: string;
    interval: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    error: string | null;
    optimizedWeights: Record<string, number> | null;
    templateVersion: number | null;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
  };
  progress: {
    percent: number;
    currentWindow: number;
    totalWindows: number;
    candidatesTested: number;
    validResults: number;
    estimatedTimeRemaining: number;
  };
}

export function OptimizationProgress({ jobId, onComplete }: OptimizationProgressProps) {
  const { data, isLoading, error } = useQuery<JobStatus>({
    queryKey: ['optimization-job', jobId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/optimize-template/${jobId}`);
      if (!res.ok) throw new Error('Failed to fetch job status');
      return res.json();
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 3000;

      const status = data.job.status;
      if (status === 'running') return 2000; // Poll every 2s while running
      if (status === 'completed' || status === 'failed') {
        onComplete?.();
        return false; // Stop polling
      }
      return 3000;
    },
    refetchOnWindowFocus: false,
  });

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
          Failed to load optimization status: {(error as Error).message}
        </AlertDescription>
      </Alert>
    );
  }

  if (!data) return null;

  const { job, progress } = data;
  const isRunning = job.status === 'running';
  const isCompleted = job.status === 'completed';
  const isFailed = job.status === 'failed';

  const statusColors = {
    pending: 'secondary',
    running: 'default',
    completed: 'success',
    failed: 'destructive',
  } as const;

  const statusIcons = {
    pending: Clock,
    running: Loader2,
    completed: CheckCircle2,
    failed: AlertCircle,
  };

  const StatusIcon = statusIcons[job.status];

  return (
    <Card className={isCompleted ? 'border-green-500' : isFailed ? 'border-destructive' : ''}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <StatusIcon
                className={`h-5 w-5 ${isRunning ? 'animate-spin' : ''} ${
                  isCompleted ? 'text-green-500' : isFailed ? 'text-destructive' : ''
                }`}
              />
              Optimization {isRunning ? 'In Progress' : isCompleted ? 'Completed' : isFailed ? 'Failed' : 'Pending'}
            </CardTitle>
            <CardDescription>
              {job.tradingStyle.replace('_', ' ')} • {job.symbol} • {job.interval}
            </CardDescription>
          </div>
          <Badge variant={statusColors[job.status]}>
            {job.status.toUpperCase()}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isRunning && (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-medium">{progress.percent}%</span>
              </div>
              <Progress value={progress.percent} className="h-2" />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-2">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Windows</p>
                <p className="text-lg font-semibold">
                  {progress.currentWindow} / {progress.totalWindows}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Candidates Tested</p>
                <p className="text-lg font-semibold">{progress.candidatesTested}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Valid Results</p>
                <p className="text-lg font-semibold">{progress.validResults}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Time Remaining</p>
                <p className="text-lg font-semibold">
                  {progress.estimatedTimeRemaining > 0
                    ? `~${Math.ceil(progress.estimatedTimeRemaining / 60)}m`
                    : 'Calculating...'}
                </p>
              </div>
            </div>
          </>
        )}

        {isCompleted && job.optimizedWeights && (
          <Alert className="border-green-500">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <AlertTitle>Optimization Successful</AlertTitle>
            <AlertDescription>
              <div className="space-y-2 mt-2">
                <p>
                  Created template version {job.templateVersion} with optimized weights.
                </p>
                <p className="text-sm">
                  Tested {progress.candidatesTested} weight combinations, {progress.validResults} passed robustness filters.
                </p>
                <p className="text-sm text-muted-foreground">
                  Completed {job.completedAt ? formatDistanceToNow(new Date(job.completedAt), { addSuffix: true }) : 'just now'}
                </p>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {isFailed && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Optimization Failed</AlertTitle>
            <AlertDescription>
              {job.error || 'Unknown error occurred during optimization'}
            </AlertDescription>
          </Alert>
        )}

        {job.startedAt && (
          <div className="text-xs text-muted-foreground pt-2 border-t">
            Started {formatDistanceToNow(new Date(job.startedAt), { addSuffix: true })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
