'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  TrendingUp,
  TrendingDown,
  Zap,
} from 'lucide-react';
import type { SignalWeights } from '@/types/signal';

interface TemplateComparisonProps {
  templateId: string;
}

interface TemplateData {
  id: string;
  tradingStyle: string;
  version: number;
  weights: SignalWeights;
  thresholds: {
    entryThreshold: number;
    exitThreshold: number;
    shortEntryThreshold: number;
    shortExitThreshold: number;
  };
  performanceMetrics: {
    avgSharpe: number;
    avgWinRate: number;
    totalBacktests: number;
    lastOptimizedAt: string;
  };
  active: boolean;
}

interface ComparisonData {
  currentTemplate: TemplateData | null;
  optimizedTemplate: TemplateData;
}

export function TemplateComparison({ templateId }: TemplateComparisonProps) {
  const queryClient = useQueryClient();
  const [activationSuccess, setActivationSuccess] = useState(false);

  const { data, isLoading, error } = useQuery<ComparisonData>({
    queryKey: ['template-comparison', templateId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/template-comparison/${templateId}`);
      if (!res.ok) throw new Error('Failed to fetch template comparison');
      return res.json();
    },
  });

  const activateMutation = useMutation({
    mutationFn: async (templateId: string) => {
      const res = await fetch('/api/admin/activate-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to activate template');
      }

      return res.json();
    },
    onSuccess: () => {
      setActivationSuccess(true);
      queryClient.invalidateQueries({ queryKey: ['template-comparison'] });
      queryClient.invalidateQueries({ queryKey: ['optimization-jobs'] });
    },
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
          Failed to load template comparison: {(error as Error).message}
        </AlertDescription>
      </Alert>
    );
  }

  if (!data) return null;

  const { currentTemplate, optimizedTemplate } = data;

  const weightCategories: Array<keyof SignalWeights> = [
    'trend',
    'momentum',
    'volume',
    'volatility',
    'futures',
    'sentiment',
  ];

  const formatPercent = (val: number) => `${(val * 100).toFixed(1)}%`;

  const getWeightChange = (old: number, new_: number) => {
    const change = new_ - old;
    const percentChange = ((change / old) * 100).toFixed(1);
    return { change, percentChange, isIncrease: change > 0 };
  };

  return (
    <div className="space-y-6">
      {activationSuccess && (
        <Alert className="border-green-500">
          <CheckCircle2 className="h-4 w-4 text-green-500" />
          <AlertTitle>Template Activated</AlertTitle>
          <AlertDescription>
            The optimized template is now active and will be used for signal generation.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle>Template Comparison</CardTitle>
              <CardDescription>
                {optimizedTemplate.tradingStyle.replace('_', ' ')} • Version {optimizedTemplate.version}
              </CardDescription>
            </div>
            {!optimizedTemplate.active && (
              <Button
                onClick={() => activateMutation.mutate(optimizedTemplate.id)}
                disabled={activateMutation.isPending}
                className="min-w-[140px]"
              >
                {activateMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Activating...
                  </>
                ) : (
                  <>
                    <Zap className="mr-2 h-4 w-4" />
                    Activate Template
                  </>
                )}
              </Button>
            )}
            {optimizedTemplate.active && (
              <Badge variant="success" className="text-sm">
                <CheckCircle2 className="mr-1 h-3 w-3" />
                Active
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Performance Metrics Comparison */}
          <div>
            <h3 className="text-sm font-medium mb-4">Performance Metrics</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Sharpe Ratio</span>
                      {currentTemplate && (
                        <span className="text-xs text-muted-foreground">
                          Current: {currentTemplate.performanceMetrics.avgSharpe.toFixed(2)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-2xl font-bold">
                        {optimizedTemplate.performanceMetrics.avgSharpe.toFixed(2)}
                      </span>
                      {currentTemplate && (
                        <>
                          {optimizedTemplate.performanceMetrics.avgSharpe >
                          currentTemplate.performanceMetrics.avgSharpe ? (
                            <TrendingUp className="h-4 w-4 text-green-500" />
                          ) : (
                            <TrendingDown className="h-4 w-4 text-red-500" />
                          )}
                          <span className="text-sm text-muted-foreground">
                            {(
                              ((optimizedTemplate.performanceMetrics.avgSharpe -
                                currentTemplate.performanceMetrics.avgSharpe) /
                                currentTemplate.performanceMetrics.avgSharpe) *
                              100
                            ).toFixed(1)}
                            %
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Win Rate</span>
                      {currentTemplate && (
                        <span className="text-xs text-muted-foreground">
                          Current: {formatPercent(currentTemplate.performanceMetrics.avgWinRate)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-2xl font-bold">
                        {formatPercent(optimizedTemplate.performanceMetrics.avgWinRate)}
                      </span>
                      {currentTemplate && (
                        <>
                          {optimizedTemplate.performanceMetrics.avgWinRate >
                          currentTemplate.performanceMetrics.avgWinRate ? (
                            <TrendingUp className="h-4 w-4 text-green-500" />
                          ) : (
                            <TrendingDown className="h-4 w-4 text-red-500" />
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6">
                  <div className="space-y-2">
                    <span className="text-sm text-muted-foreground">Total Backtests</span>
                    <div className="flex items-center gap-2">
                      <span className="text-2xl font-bold">
                        {optimizedTemplate.performanceMetrics.totalBacktests}
                      </span>
                      <span className="text-sm text-muted-foreground">windows</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <Separator />

          {/* Weight Comparison */}
          <div>
            <h3 className="text-sm font-medium mb-4">Signal Weights</h3>
            <div className="space-y-3">
              {weightCategories.map((category) => {
                const currentWeight = currentTemplate?.weights[category] ?? 0;
                const optimizedWeight = optimizedTemplate.weights[category];
                const change = currentTemplate
                  ? getWeightChange(currentWeight, optimizedWeight)
                  : null;

                return (
                  <div key={category} className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="capitalize font-medium">{category}</span>
                      <div className="flex items-center gap-4">
                        {currentTemplate && (
                          <>
                            <span className="text-muted-foreground">
                              {formatPercent(currentWeight)}
                            </span>
                            <ArrowRight className="h-4 w-4 text-muted-foreground" />
                          </>
                        )}
                        <span className="font-mono font-bold">
                          {formatPercent(optimizedWeight)}
                        </span>
                        {change && (
                          <span
                            className={`text-xs ${
                              change.isIncrease ? 'text-green-500' : 'text-red-500'
                            }`}
                          >
                            {change.isIncrease ? '+' : ''}
                            {change.percentChange}%
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${optimizedWeight * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <Separator />

          {/* Thresholds */}
          <div>
            <h3 className="text-sm font-medium mb-4">Signal Thresholds</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Long Entry</p>
                <p className="font-mono font-bold">
                  {optimizedTemplate.thresholds.entryThreshold}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Long Exit</p>
                <p className="font-mono font-bold">
                  {optimizedTemplate.thresholds.exitThreshold}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Short Entry</p>
                <p className="font-mono font-bold">
                  {optimizedTemplate.thresholds.shortEntryThreshold}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Short Exit</p>
                <p className="font-mono font-bold">
                  {optimizedTemplate.thresholds.shortExitThreshold}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
