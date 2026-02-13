'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, Loader2, Zap } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { TradingStyle } from '@/lib/models/signal-template';

const formSchema = z.object({
  tradingStyle: z.enum(['scalping', 'day_trading', 'swing_trading', 'position_trading']),
  symbol: z.string().min(1, 'Symbol is required').toUpperCase(),
  interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']),
  months: z.number().min(1).max(12),
});

type FormValues = z.infer<typeof formSchema>;

interface OptimizationFormProps {
  onOptimizationStarted: (jobId: string) => void;
  disabled?: boolean;
}

export function OptimizationForm({ onOptimizationStarted, disabled }: OptimizationFormProps) {
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      tradingStyle: 'day_trading',
      symbol: 'BTCUSDT',
      interval: '1h',
      months: 6,
    },
  });

  const optimizeMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const res = await fetch('/api/admin/optimize-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start optimization');
      }

      return res.json();
    },
    onSuccess: (data) => {
      setError(null);
      onOptimizationStarted(data.jobId);
      form.reset();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const onSubmit = (values: FormValues) => {
    setError(null);
    optimizeMutation.mutate(values);
  };

  const tradingStyleLabels: Record<TradingStyle, string> = {
    scalping: 'Scalping (Minutes)',
    day_trading: 'Day Trading (Hours)',
    swing_trading: 'Swing Trading (Days)',
    position_trading: 'Position Trading (Weeks)',
  };

  const intervalLabels: Record<string, string> = {
    '1m': '1 Minute',
    '5m': '5 Minutes',
    '15m': '15 Minutes',
    '1h': '1 Hour',
    '4h': '4 Hours',
    '1d': '1 Day',
  };

  const months = form.watch('months');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5" />
          Start New Optimization
        </CardTitle>
        <CardDescription>
          Configure parameters for walk-forward optimization. This will test hundreds of weight
          combinations to discover optimal signal template weights.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="tradingStyle"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Trading Style</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                      disabled={disabled || optimizeMutation.isPending}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select trading style" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(tradingStyleLabels).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      The trading timeframe to optimize
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="symbol"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Symbol</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="BTCUSDT"
                        {...field}
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                        disabled={disabled || optimizeMutation.isPending}
                      />
                    </FormControl>
                    <FormDescription>
                      Trading pair symbol (e.g., BTCUSDT, ETHUSDT)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="interval"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Timeframe</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                      disabled={disabled || optimizeMutation.isPending}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select timeframe" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(intervalLabels).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Candlestick interval for historical data
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="months"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Historical Data Period: {months} months</FormLabel>
                    <FormControl>
                      <Slider
                        min={1}
                        max={12}
                        step={1}
                        value={[field.value]}
                        onValueChange={(vals) => field.onChange(vals[0])}
                        disabled={disabled || optimizeMutation.isPending}
                        className="py-4"
                      />
                    </FormControl>
                    <FormDescription>
                      Amount of historical data to analyze (1-12 months)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="flex items-center justify-between pt-4 border-t">
              <div className="text-sm text-muted-foreground">
                <p>Estimated runtime: ~1-2 minutes</p>
                <p className="text-xs mt-1">
                  Will test ~{Math.ceil((months * 720) / 300) * 50} weight combinations
                </p>
              </div>
              <Button
                type="submit"
                disabled={disabled || optimizeMutation.isPending}
                className="min-w-[140px]"
              >
                {optimizeMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>
                    <Zap className="mr-2 h-4 w-4" />
                    Start Optimization
                  </>
                )}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
