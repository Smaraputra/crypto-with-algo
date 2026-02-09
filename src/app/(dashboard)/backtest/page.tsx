'use client';

import { useState, useCallback, useMemo } from 'react';
import { Play, Plus, Square } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StrategyForm } from '@/components/backtest/StrategyForm';
import { StrategyList } from '@/components/backtest/StrategyList';
import { BacktestConfigPanel } from '@/components/backtest/BacktestConfigPanel';
import { BacktestProgress } from '@/components/backtest/BacktestProgress';
import { EquityCurveChart } from '@/components/backtest/EquityCurveChart';
import { BacktestMetricsCards } from '@/components/backtest/BacktestMetricsCards';
import { TradeList } from '@/components/backtest/TradeList';
import {
  useStrategies,
  useCreateStrategy,
  useUpdateStrategy,
  useDeleteStrategy,
} from '@/hooks/useStrategies';
import { useBacktest } from '@/hooks/useBacktest';
import { useUIStore } from '@/stores/uiStore';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtest/types';
import type { Strategy, CreateStrategyInput } from '@/types/strategy';
import type { BacktestConfig } from '@/lib/backtest/types';

const BINANCE_WS_INTERVALS: Record<string, string> = {
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

export default function BacktestPage() {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Strategy | undefined>(undefined);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);
  const [config, setConfig] = useState<BacktestConfig>(DEFAULT_BACKTEST_CONFIG);
  const [backtestInterval, setBacktestInterval] = useState('1h');

  const selectedSymbol = useUIStore((s) => s.selectedSymbol);

  const { data, isLoading } = useStrategies();
  const createMutation = useCreateStrategy();
  const updateMutation = useUpdateStrategy();
  const deleteMutation = useDeleteStrategy();
  const backtest = useBacktest();

  const strategies = useMemo(() => data?.strategies ?? [], [data]);
  const selectedStrategy = strategies.find((s) => s._id === selectedStrategyId);

  const handleCreate = useCallback(
    (input: CreateStrategyInput) => {
      createMutation.mutate(input, {
        onSuccess: () => setFormOpen(false),
      });
    },
    [createMutation]
  );

  const handleUpdate = useCallback(
    (input: CreateStrategyInput) => {
      if (!editing) return;
      updateMutation.mutate(
        { id: editing._id, ...input },
        {
          onSuccess: () => {
            setFormOpen(false);
            setEditing(undefined);
          },
        }
      );
    },
    [editing, updateMutation]
  );

  const handleEdit = useCallback((strategy: Strategy) => {
    setEditing(strategy);
    setFormOpen(true);
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      setDeletingId(id);
      deleteMutation.mutate(id, {
        onSettled: () => setDeletingId(null),
      });
    },
    [deleteMutation]
  );

  const handleFormClose = useCallback((open: boolean) => {
    if (!open) setEditing(undefined);
    setFormOpen(open);
  }, []);

  const handleSelectStrategy = useCallback(
    (id: string) => {
      setSelectedStrategyId(id);
      const strategy = strategies.find((s) => s._id === id);
      if (strategy) {
        setConfig((prev) => ({ ...prev, weights: strategy.weights }));
      }
    },
    [strategies]
  );

  const handleRunBacktest = useCallback(async () => {
    const symbol = selectedStrategy?.symbols[0] ?? selectedSymbol;
    const interval = BINANCE_WS_INTERVALS[backtestInterval] ?? '1h';

    try {
      // Fetch candles from Binance API
      const res = await fetch(
        `/api/market/klines?symbol=${symbol}&interval=${interval}&limit=500`
      );
      if (!res.ok) {
        toast.error('Failed to fetch candle data');
        return;
      }
      const { klines } = await res.json();
      if (!klines || klines.length < 200) {
        toast.error('Insufficient candle data for backtest');
        return;
      }

      backtest.run(klines, config, symbol, interval);
    } catch {
      toast.error('Failed to start backtest');
    }
  }, [selectedStrategy, selectedSymbol, backtestInterval, config, backtest]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Backtest</h1>
        <Button size="sm" onClick={() => setFormOpen(true)}>
          <Plus className="mr-1 size-4" />
          New Strategy
        </Button>
      </div>

      <Tabs defaultValue="configure">
        <TabsList>
          <TabsTrigger value="configure">Configure</TabsTrigger>
          <TabsTrigger value="results" disabled={!backtest.result}>
            Results
          </TabsTrigger>
        </TabsList>

        <TabsContent value="configure" className="space-y-4">
          <StrategyList
            strategies={strategies}
            isLoading={isLoading}
            onEdit={handleEdit}
            onDelete={handleDelete}
            deletingId={deletingId}
          />

          {strategies.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Select a strategy to backtest:</p>
              <div className="flex flex-wrap gap-2">
                {strategies.map((s) => (
                  <Button
                    key={s._id}
                    size="sm"
                    variant={selectedStrategyId === s._id ? 'default' : 'outline'}
                    className="h-7 text-xs"
                    onClick={() => handleSelectStrategy(s._id)}
                  >
                    {s.name}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Interval:</p>
            <div className="flex gap-2">
              {Object.keys(BINANCE_WS_INTERVALS).map((iv) => (
                <Button
                  key={iv}
                  size="sm"
                  variant={backtestInterval === iv ? 'default' : 'outline'}
                  className="h-7 text-xs"
                  onClick={() => setBacktestInterval(iv)}
                >
                  {iv}
                </Button>
              ))}
            </div>
          </div>

          <BacktestConfigPanel config={config} onChange={setConfig} />

          <div className="flex items-center gap-2">
            {backtest.status === 'running' ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={backtest.cancel}
              >
                <Square className="mr-1 size-4" />
                Cancel
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleRunBacktest}
              >
                <Play className="mr-1 size-4" />
                Run Backtest
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              {selectedStrategy?.symbols[0] ?? selectedSymbol} / {backtestInterval}
            </span>
          </div>

          {backtest.status === 'running' && (
            <BacktestProgress
              progress={backtest.progress}
              barsProcessed={backtest.barsProcessed}
              totalBars={backtest.totalBars}
            />
          )}

          {backtest.status === 'error' && (
            <p className="text-sm text-destructive">{backtest.error}</p>
          )}
        </TabsContent>

        <TabsContent value="results" className="space-y-4">
          {backtest.result && (
            <>
              <BacktestMetricsCards metrics={backtest.result.metrics} />
              <EquityCurveChart
                equityCurve={backtest.result.equityCurve}
                startEquity={backtest.result.config.startEquity}
              />
              <TradeList trades={backtest.result.trades} />
            </>
          )}
        </TabsContent>
      </Tabs>

      <StrategyForm
        open={formOpen}
        onOpenChange={handleFormClose}
        onSubmit={editing ? handleUpdate : handleCreate}
        isPending={createMutation.isPending || updateMutation.isPending}
        initial={editing}
      />
    </div>
  );
}
