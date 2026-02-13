'use client';

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
import { AlertCircle, Eye, Loader2, History } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatDistanceToNow, format } from 'date-fns';

interface OptimizationHistoryProps {
  onViewComparison: (templateId: string) => void;
}

interface HistoricalJob {
  id: string;
  tradingStyle: string;
  symbol: string;
  interval: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  templateVersion: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  progress: {
    candidatesTested: number;
    validResults: number;
  };
}

export function OptimizationHistory({ onViewComparison }: OptimizationHistoryProps) {
  const { data: jobs, isLoading, error } = useQuery<HistoricalJob[]>({
    queryKey: ['optimization-jobs'],
    queryFn: async () => {
      const res = await fetch('/api/admin/optimization-jobs');
      if (!res.ok) throw new Error('Failed to fetch optimization history');
      return res.json();
    },
    refetchInterval: 10000, // Refetch every 10s to catch new jobs
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
          Failed to load optimization history: {(error as Error).message}
        </AlertDescription>
      </Alert>
    );
  }

  const statusColors = {
    pending: 'secondary',
    running: 'default',
    completed: 'success',
    failed: 'destructive',
  } as const;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5" />
          Optimization History
        </CardTitle>
        <CardDescription>
          View past and ongoing optimization jobs
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!jobs || jobs.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <History className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>No optimization jobs yet</p>
            <p className="text-sm mt-2">Start your first optimization to see it here</p>
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Style</TableHead>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Interval</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Tested</TableHead>
                  <TableHead className="text-right">Valid</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => {
                  const duration =
                    job.startedAt && job.completedAt
                      ? Math.round(
                          (new Date(job.completedAt).getTime() -
                            new Date(job.startedAt).getTime()) /
                            1000
                        )
                      : null;

                  return (
                    <TableRow key={job.id}>
                      <TableCell className="font-medium">
                        <div className="flex flex-col">
                          <span>{format(new Date(job.createdAt), 'MMM d, yyyy')}</span>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(job.createdAt), 'h:mm a')}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="capitalize">
                          {job.tradingStyle.replace('_', ' ')}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono">{job.symbol}</TableCell>
                      <TableCell className="font-mono">{job.interval}</TableCell>
                      <TableCell>
                        <Badge variant={statusColors[job.status]}>
                          {job.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {job.progress.candidatesTested}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {job.progress.validResults}
                      </TableCell>
                      <TableCell className="text-right">
                        {duration ? `${duration}s` : job.status === 'running' ? 'Running...' : '-'}
                      </TableCell>
                      <TableCell className="text-right">
                        {job.status === 'completed' && job.templateVersion && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onViewComparison(job.id)}
                          >
                            <Eye className="h-4 w-4 mr-1" />
                            Compare
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
