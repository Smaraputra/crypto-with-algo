'use client';

import React, { useState } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { VALID_SYMBOLS } from '@/types/strategy';
import { DEFAULT_BACKTEST_CONFIG, type BacktestConfig, type BacktestResult } from '@/lib/backtest/types';
import type { DataRange } from '@/lib/backtest/options';
import { useBacktest } from '@/hooks/useBacktest';
import { PageHeader } from '@/components/kit/PageHeader';
import { EvidenceChip } from '@/components/kit/EvidenceChip';
import { StrategyConfig } from './StrategyConfig';
import { RunPanel } from './RunPanel';
import { ResultsView } from './ResultsView';
import { SavedResults } from './SavedResults';
import { cn } from '@/lib/utils';

export interface BacktestScreenProps {
  className?: string;
}

export const BacktestScreen: React.FC<BacktestScreenProps> = ({ className }) => {
  const storeSymbol = useUIStore((s) => s.selectedSymbol);
  const initialSymbol = (VALID_SYMBOLS as readonly string[]).includes(storeSymbol)
    ? storeSymbol
    : 'BTCUSDT';

  const [symbol, setSymbol] = useState<string>(initialSymbol);
  const [interval, setInterval] = useState<string>('1h');
  const [dataRange, setDataRange] = useState<DataRange>('6m');
  const [config, setConfig] = useState<BacktestConfig>(DEFAULT_BACKTEST_CONFIG);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);

  const {
    status,
    progress,
    barsProcessed,
    totalBars,
    result: runResult,
    error: runError,
    run,
    cancel,
  } = useBacktest();

  const [selectedSavedResult, setSelectedSavedResult] = useState<BacktestResult | null>(null);
  const [isConfigValid, setIsConfigValid] = useState(true);

  const handleRun = (
    candles: Parameters<typeof run>[0],
    cfg: Parameters<typeof run>[1],
    sym: Parameters<typeof run>[2],
    iv: Parameters<typeof run>[3],
    snaps?: Parameters<typeof run>[4],
    htf?: Parameters<typeof run>[5]
  ) => {
    setSelectedSavedResult(null);
    run(candles, cfg, sym, iv, snaps, htf);
  };

  const activeResult = selectedSavedResult ?? runResult;

  return (
    <div className={cn('space-y-4', className)}>
      <PageHeader
        title="Backtest"
        description="Rules built on the price score were measured on years of history and lost after costs. A strong result here is more likely chance or overfitting than an edge."
        actions={<EvidenceChip kind="no-edge" />}
      />

      {/* Desktop: configuration on the left, run and results on the right. Phone: stacked. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
        <div data-testid="left-column" className="lg:col-span-5 flex flex-col gap-6">
          <StrategyConfig
            symbol={symbol}
            onSymbolChange={setSymbol}
            interval={interval}
            onIntervalChange={setInterval}
            dataRange={dataRange}
            onDataRangeChange={setDataRange}
            config={config}
            onConfigChange={setConfig}
            selectedStrategyId={selectedStrategyId}
            onSelectedStrategyIdChange={setSelectedStrategyId}
            onValidityChange={setIsConfigValid}
          />
        </div>

        <div data-testid="right-column" className="lg:col-span-7 flex flex-col gap-6">
          <RunPanel
            symbol={symbol}
            interval={interval}
            dataRange={dataRange}
            config={config}
            status={status}
            progress={progress}
            barsProcessed={barsProcessed}
            totalBars={totalBars}
            onRun={handleRun}
            onCancel={cancel}
            disabled={!isConfigValid}
          />
          <ResultsView
            result={activeResult}
            error={selectedSavedResult ? null : runError}
            selectedStrategyId={selectedStrategyId}
            isSavedResult={Boolean(selectedSavedResult)}
          />
          <SavedResults
            onSelectResult={(saved) => {
              setSelectedSavedResult(saved);
            }}
          />
        </div>
      </div>
    </div>
  );
};
