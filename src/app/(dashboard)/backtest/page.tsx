'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Play, Plus, Save, Square } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StrategyForm } from '@/components/backtest/StrategyForm';
import { StrategyList } from '@/components/backtest/StrategyList';
import { BacktestConfigPanel } from '@/components/backtest/BacktestConfigPanel';
import { BacktestProgress } from '@/components/backtest/BacktestProgress';
import { DataStatus } from '@/components/backtest/DataStatus';
import { WeightSliders } from '@/components/backtest/WeightSliders';
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
import { useSaveBacktestResult, useBacktestResults, useDeleteBacktestResult } from '@/hooks/useBacktestResults';
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

/** Milliseconds per bar for each interval, used to compute startTime for N bars */
const INTERVAL_MS: Record<string, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

const DATA_RANGE_OPTIONS = [
  { label: '500 bars', value: 'legacy', months: 0 },
  { label: '3 months', value: '3m', months: 3 },
  { label: '6 months', value: '6m', months: 6 },
  { label: '1 year', value: '1y', months: 12 },
  { label: '2 years', value: '2y', months: 24 },
] as const;

type DataRange = (typeof DATA_RANGE_OPTIONS)[number]['value'];

export default function BacktestPage() {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Strategy | undefined>(undefined);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);
  const [config, setConfig] = useState<BacktestConfig>(DEFAULT_BACKTEST_CONFIG);
  const [backtestInterval, setBacktestInterval] = useState('1h');
  const [dataRange, setDataRange] = useState<DataRange>('6m');
  const [fetchingCandles, setFetchingCandles] = useState(false);
  const [activeTab, setActiveTab] = useState('configure');

  const selectedSymbol = useUIStore((s) => s.selectedSymbol);

  const { data, isLoading } = useStrategies();
  const createMutation = useCreateStrategy();
  const updateMutation = useUpdateStrategy();
  const deleteMutation = useDeleteStrategy();
  const backtest = useBacktest();
  const saveMutation = useSaveBacktestResult();
  const { data: savedResults } = useBacktestResults();
  const deleteResultMutation = useDeleteBacktestResult();

  // Auto-navigate to results when backtest completes
  useEffect(() => {
    if (backtest.status === 'complete') {
      setActiveTab('results');
    }
  }, [backtest.status]);

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

  const handleSaveResult = useCallback(() => {
    if (!backtest.result) return;
    const r = backtest.result;
    saveMutation.mutate({
      strategyId: selectedStrategyId ?? undefined,
      symbol: r.symbol,
      interval: r.interval,
      config: r.config as unknown as Record<string, unknown>,
      metrics: r.metrics as unknown as Record<string, unknown>,
      trades: r.trades as unknown as Record<string, unknown>[],
      equityCurve: r.equityCurve as unknown as Record<string, unknown>[],
      totalBars: r.totalBars,
      warmupBars: r.warmupBars,
      startTime: r.startTime,
      endTime: r.endTime,
    });
  }, [backtest.result, selectedStrategyId, saveMutation]);

  const handleDeleteResult = useCallback(
    (id: string) => {
      deleteResultMutation.mutate(id);
    },
    [deleteResultMutation]
  );

  const handleRunBacktest = useCallback(async () => {
    const symbol = selectedStrategy?.symbols[0] ?? selectedSymbol;
    const interval = BINANCE_WS_INTERVALS[backtestInterval] ?? '1h';
    const rangeOption = DATA_RANGE_OPTIONS.find((r) => r.value === dataRange);

    setFetchingCandles(true);

    try {
      let klines;

      if (dataRange === 'legacy' || !rangeOption) {
        // Legacy: fetch 500 candles from stored data
        const barMs = INTERVAL_MS[interval] ?? 3600000;
        const startTime = Date.now() - 500 * barMs;
        const res = await fetch(
          `/api/candles?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=500`
        );
        if (!res.ok) {
          toast.error('Failed to fetch candle data');
          return;
        }
        const data = await res.json();
        klines = data.candles;
      } else {
        // Deep history: fetch from MongoDB via /api/candles
        const startTime = Date.now() - rangeOption.months * 30 * 24 * 60 * 60 * 1000;
        const res = await fetch(
          `/api/candles?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=50000`
        );
        if (!res.ok) {
          toast.error('Failed to fetch candle data');
          return;
        }
        const data = await res.json();
        klines = data.candles;
      }

      if (!klines || klines.length < 200) {
        toast.error(
          `Insufficient candle data (${klines?.length ?? 0} bars). Try downloading history first.`
        );
        return;
      }

      backtest.run(klines, config, symbol, interval);
    } catch {
      toast.error('Failed to start backtest');
    } finally {
      setFetchingCandles(false);
    }
  }, [selectedStrategy, selectedSymbol, backtestInterval, dataRange, config, backtest]);

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-lg font-semibold text-foreground">Backtest</h1>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="configure">Configure</TabsTrigger>
          <TabsTrigger value="results">Results</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="configure" className="space-y-4">
          {/* Strategy section */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Strategy</CardTitle>
                <Button size="sm" variant="outline" onClick={() => setFormOpen(true)}>
                  <Plus className="mr-1 size-3" />
                  New Strategy
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
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
                        size="xs"
                        variant={selectedStrategyId === s._id ? 'default' : 'outline'}
                        onClick={() => handleSelectStrategy(s._id)}
                      >
                        {s.name}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {selectedStrategy && (
                <WeightSliders
                  weights={config.weights}
                  onChange={(weights) => setConfig((prev) => ({ ...prev, weights }))}
                />
              )}
            </CardContent>
          </Card>

          {/* Market & Data section */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Market &amp; Data</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground font-mono">
                  {selectedStrategy?.symbols[0] ?? selectedSymbol}
                </span>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Interval:</p>
                <div className="flex gap-2">
                  {Object.keys(BINANCE_WS_INTERVALS).map((iv) => (
                    <Button
                      key={iv}
                      size="xs"
                      variant={backtestInterval === iv ? 'default' : 'outline'}
                      onClick={() => setBacktestInterval(iv)}
                    >
                      {iv}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Data Range:</p>
                <div className="flex flex-wrap gap-2">
                  {DATA_RANGE_OPTIONS.map((opt) => (
                    <Button
                      key={opt.value}
                      size="xs"
                      variant={dataRange === opt.value ? 'default' : 'outline'}
                      onClick={() => setDataRange(opt.value)}
                    >
                      {opt.label}
                    </Button>
                  ))}
                </div>
              </div>

              <DataStatus
                symbol={selectedStrategy?.symbols[0] ?? selectedSymbol}
                interval={backtestInterval}
                compact
              />
            </CardContent>
          </Card>

          {/* Configuration */}
          <BacktestConfigPanel config={config} onChange={setConfig} />

          {/* Run section */}
          <Card>
            <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              {backtest.status === 'running' || fetchingCandles ? (
                <Button
                  size="sm"
                  variant="destructive"
                  className="w-full"
                  onClick={backtest.cancel}
                  disabled={fetchingCandles}
                >
                  <Square className="mr-1 size-4" />
                  {fetchingCandles ? 'Loading data...' : 'Cancel'}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="w-full"
                  onClick={handleRunBacktest}
                >
                  <Play className="mr-1 size-4" />
                  Run Backtest
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground text-center" data-testid="run-summary">
              {selectedStrategy?.symbols[0] ?? selectedSymbol} / {backtestInterval} / {DATA_RANGE_OPTIONS.find((r) => r.value === dataRange)?.label ?? dataRange}
            </p>

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
          </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="results" className="space-y-4">
          {backtest.result ? (
            <>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleSaveResult}
                  disabled={saveMutation.isPending}
                  data-testid="save-backtest-button"
                >
                  <Save className="mr-1 size-3.5" />
                  {saveMutation.isPending ? 'Saving...' : 'Save Result'}
                </Button>
              </div>
              <BacktestMetricsCards metrics={backtest.result.metrics} />
              <EquityCurveChart
                equityCurve={backtest.result.equityCurve}
                startEquity={backtest.result.config.startEquity}
              />
              <TradeList trades={backtest.result.trades} />
            </>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground" data-testid="results-empty">
              Run a backtest to see results.
            </p>
          )}
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          {(savedResults?.results ?? []).length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground" data-testid="history-empty">
              No saved backtest results yet. Run a backtest and save the results.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="history-table">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-4">Date</th>
                    <th className="pb-2 pr-4">Symbol</th>
                    <th className="pb-2 pr-4">Interval</th>
                    <th className="pb-2 pr-4">PnL</th>
                    <th className="pb-2 pr-4">Win Rate</th>
                    <th className="pb-2 pr-4">Trades</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {(savedResults?.results ?? []).map((r) => (
                    <tr key={r._id} className="border-b border-border/50">
                      <td className="py-2 pr-4 text-xs text-muted-foreground">
                        {new Date(r.createdAt).toLocaleDateString()}
                      </td>
                      <td className="py-2 pr-4 text-xs">{r.symbol}</td>
                      <td className="py-2 pr-4 text-xs">{r.interval}</td>
                      <td className="py-2 pr-4 font-mono tabular-nums text-xs">
                        <span className={r.metrics.totalPnl > 0 ? 'text-bullish' : 'text-bearish'}>
                          {r.metrics.totalPnl > 0 ? '+' : ''}
                          {r.metrics.totalPnlPercent.toFixed(2)}%
                        </span>
                      </td>
                      <td className="py-2 pr-4 font-mono tabular-nums text-xs">
                        {(r.metrics.winRate * 100).toFixed(1)}%
                      </td>
                      <td className="py-2 pr-4 font-mono tabular-nums text-xs">
                        {r.metrics.totalTrades}
                      </td>
                      <td className="py-2 text-xs">
                        <Button
                          size="xs"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => handleDeleteResult(r._id)}
                          disabled={deleteResultMutation.isPending}
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
