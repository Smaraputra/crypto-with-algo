'use client';

import React, { useState, useEffect, useId } from 'react';
import { useStrategies, useCreateStrategy, useUpdateStrategy, useDeleteStrategy } from '@/hooks/useStrategies';
import type { BacktestConfig } from '@/lib/backtest/types';
import { DEFAULT_WEIGHTS, type SignalWeights } from '@/types/signal';
import {
  VALID_SYMBOLS,
  VALID_INTERVALS,
  createStrategySchema,
  type Strategy,
} from '@/types/strategy';
import {
  BINANCE_WS_INTERVALS,
  DATA_RANGE_OPTIONS,
  type DataRange,
} from '@/lib/backtest/options';
import {
  MARKET_SESSIONS,
  SESSION_LABELS,
  type MarketSession,
} from '@/lib/sessions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export function formatDataStatusDate(timestampMs: number): string {
  const d = new Date(timestampMs);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export interface StrategyConfigProps {
  symbol: string;
  onSymbolChange: (symbol: string) => void;
  interval: string;
  onIntervalChange: (interval: string) => void;
  dataRange: DataRange;
  onDataRangeChange: (range: DataRange) => void;
  config: BacktestConfig;
  onConfigChange: React.Dispatch<React.SetStateAction<BacktestConfig>>;
  selectedStrategyId: string | null;
  onSelectedStrategyIdChange: (id: string | null) => void;
  onValidityChange?: (isValid: boolean) => void;
  dataStatusRefreshKey?: number;
  className?: string;
}

const WEIGHT_LABELS: Record<keyof SignalWeights, string> = {
  trend: 'Trend',
  momentum: 'Momentum',
  volume: 'Volume',
  volatility: 'Volatility',
  futures: 'Futures',
  sentiment: 'Sentiment',
  htf: 'Higher timeframe (HTF)',
};

const WEIGHT_KEYS: Array<keyof SignalWeights> = [
  'trend',
  'momentum',
  'volume',
  'volatility',
  'futures',
  'sentiment',
  'htf',
];

function parseNumberInput(
  raw: string,
  options?: { min?: number; max?: number; boundError?: string }
): { parsed: number | null; error: string | null } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { parsed: null, error: 'Enter a number.' };
  }
  const val = Number(trimmed);
  if (!Number.isFinite(val)) {
    return { parsed: null, error: 'Enter a number.' };
  }
  if (options?.min !== undefined && options?.max !== undefined) {
    if (val < options.min || val > options.max) {
      return {
        parsed: null,
        error: options.boundError ?? `Must be between ${options.min} and ${options.max}.`,
      };
    }
  } else if (options?.min !== undefined) {
    if (val < options.min) {
      return {
        parsed: null,
        error: options.boundError ?? `Must be at least ${options.min}.`,
      };
    }
  } else if (options?.max !== undefined) {
    if (val > options.max) {
      return {
        parsed: null,
        error: options.boundError ?? `Must be at most ${options.max}.`,
      };
    }
  }
  return { parsed: val, error: null };
}

export const StrategyConfig: React.FC<StrategyConfigProps> = ({
  symbol,
  onSymbolChange,
  interval,
  onIntervalChange,
  dataRange,
  onDataRangeChange,
  config,
  onConfigChange,
  selectedStrategyId,
  onSelectedStrategyIdChange,
  onValidityChange,
  className,
}) => {
  const idPrefix = useId();

  // Strategy list & mutations
  const { data: strategiesData, isLoading: isLoadingStrategies } = useStrategies();
  const strategies = strategiesData?.strategies ?? [];
  const selectedStrategy = strategies.find((s) => s._id === selectedStrategyId);

  const createStrategyMutation = useCreateStrategy();
  const updateStrategyMutation = useUpdateStrategy();
  const deleteStrategyMutation = useDeleteStrategy();

  // New Strategy modal state
  const [isNewOpen, setIsNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSymbols, setNewSymbols] = useState<string[]>([symbol]);
  const [newIntervals, setNewIntervals] = useState<string[]>([interval]);
  const [newError, setNewError] = useState<string | null>(null);

  // Rename modal state
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  // Delete confirm state
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  // Local state for number inputs
  const [entryThresholdText, setEntryThresholdText] = useState(String(config.entryThreshold));
  const [entryThresholdError, setEntryThresholdError] = useState<string | null>(null);

  const [exitThresholdText, setExitThresholdText] = useState(String(config.exitThreshold));
  const [exitThresholdError, setExitThresholdError] = useState<string | null>(null);

  const [shortEntryThresholdText, setShortEntryThresholdText] = useState(String(config.shortEntryThreshold));
  const [shortEntryThresholdError, setShortEntryThresholdError] = useState<string | null>(null);

  const [shortExitThresholdText, setShortExitThresholdText] = useState(String(config.shortExitThreshold));
  const [shortExitThresholdError, setShortExitThresholdError] = useState<string | null>(null);

  const [stopLossText, setStopLossText] = useState(String(Math.round(config.stopLossPercent * 1000) / 10));
  const [stopLossError, setStopLossError] = useState<string | null>(null);

  const [takeProfitText, setTakeProfitText] = useState(String(Math.round(config.takeProfitPercent * 1000) / 10));
  const [takeProfitError, setTakeProfitError] = useState<string | null>(null);

  const [positionSizeText, setPositionSizeText] = useState(String(Math.round(config.positionSizePercent * 1000) / 10));
  const [positionSizeError, setPositionSizeError] = useState<string | null>(null);

  const [feePercentText, setFeePercentText] = useState(String(Math.round(config.feePercent * 10000) / 100));
  const [feePercentError, setFeePercentError] = useState<string | null>(null);

  const [startEquityText, setStartEquityText] = useState(String(config.startEquity));
  const [startEquityError, setStartEquityError] = useState<string | null>(null);

  const [prevConfig, setPrevConfig] = useState(config);
  if (prevConfig !== config) {
    setPrevConfig(config);

    if (parseFloat(entryThresholdText) !== config.entryThreshold) {
      setEntryThresholdText(String(config.entryThreshold));
      setEntryThresholdError(null);
    }
    if (parseFloat(exitThresholdText) !== config.exitThreshold) {
      setExitThresholdText(String(config.exitThreshold));
      setExitThresholdError(null);
    }
    if (parseFloat(shortEntryThresholdText) !== config.shortEntryThreshold) {
      setShortEntryThresholdText(String(config.shortEntryThreshold));
      setShortEntryThresholdError(null);
    }
    if (parseFloat(shortExitThresholdText) !== config.shortExitThreshold) {
      setShortExitThresholdText(String(config.shortExitThreshold));
      setShortExitThresholdError(null);
    }

    const sl = Math.round(config.stopLossPercent * 1000) / 10;
    if (parseFloat(stopLossText) !== sl) {
      setStopLossText(String(sl));
      setStopLossError(null);
    }

    const tp = Math.round(config.takeProfitPercent * 1000) / 10;
    if (parseFloat(takeProfitText) !== tp) {
      setTakeProfitText(String(tp));
      setTakeProfitError(null);
    }

    const ps = Math.round(config.positionSizePercent * 1000) / 10;
    if (parseFloat(positionSizeText) !== ps) {
      setPositionSizeText(String(ps));
      setPositionSizeError(null);
    }

    const fee = Math.round(config.feePercent * 10000) / 100;
    if (parseFloat(feePercentText) !== fee) {
      setFeePercentText(String(fee));
      setFeePercentError(null);
    }

    if (parseFloat(startEquityText) !== config.startEquity) {
      setStartEquityText(String(config.startEquity));
      setStartEquityError(null);
    }
  }

  const hasFieldErrors = Boolean(
    entryThresholdError ||
    exitThresholdError ||
    (config.allowShorts && (shortEntryThresholdError || shortExitThresholdError)) ||
    stopLossError ||
    takeProfitError ||
    positionSizeError ||
    feePercentError ||
    startEquityError
  );

  useEffect(() => {
    onValidityChange?.(!hasFieldErrors);
  }, [hasFieldErrors, onValidityChange]);

  // Weights sum & validation
  const weights = config.weights;
  const weightsSum =
    (weights.trend ?? 0) +
    (weights.momentum ?? 0) +
    (weights.volume ?? 0) +
    (weights.volatility ?? 0) +
    (weights.futures ?? 0) +
    (weights.sentiment ?? 0) +
    (weights.htf ?? 0);
  const totalPercent = Math.round(weightsSum * 100);
  const isWeightsTotalValid = Math.abs(weightsSum - 1.0) < 0.01;

  // Handlers
  const handleStrategyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (!val) {
      onSelectedStrategyIdChange(null);
      return;
    }
    const found = strategies.find((s) => s._id === val);
    if (found) {
      onSelectedStrategyIdChange(found._id);
      onConfigChange((prev) => ({
        ...prev,
        weights: {
          ...found.weights,
          htf: found.weights.htf ?? 0,
        },
      }));
      if (found.symbols && found.symbols.length > 0) {
        onSymbolChange(found.symbols[0]);
      }
    }
  };

  const handleOpenNewStrategy = () => {
    setNewName('');
    setNewSymbols(VALID_SYMBOLS.includes(symbol as (typeof VALID_SYMBOLS)[number]) ? [symbol] : ['BTCUSDT']);
    setNewIntervals(VALID_INTERVALS.includes(interval as (typeof VALID_INTERVALS)[number]) ? [interval] : ['1h']);
    setNewError(null);
    setIsNewOpen(true);
  };

  const handleCreateStrategySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNewError(null);

    const payload = {
      name: newName.trim(),
      symbols: newSymbols,
      intervals: newIntervals as ('15m' | '1h' | '4h' | '1d')[],
      weights: {
        trend: weights.trend,
        momentum: weights.momentum,
        volume: weights.volume,
        volatility: weights.volatility,
        futures: weights.futures,
        sentiment: weights.sentiment,
        htf: weights.htf ?? 0,
      },
    };

    const parsed = createStrategySchema.safeParse(payload);
    if (!parsed.success) {
      setNewError(parsed.error.issues[0]?.message ?? 'Invalid strategy configuration');
      return;
    }

    try {
      const res = (await createStrategyMutation.mutateAsync(parsed.data)) as {
        strategy?: { _id?: string };
      };
      setIsNewOpen(false);
      if (res?.strategy?._id) {
        onSelectedStrategyIdChange(res.strategy._id);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create strategy';
      setNewError(msg);
    }
  };

  const handleOpenRename = () => {
    if (!selectedStrategy) return;
    setRenameValue(selectedStrategy.name);
    setRenameError(null);
    setIsRenameOpen(true);
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStrategy) return;
    const trimmed = renameValue.trim();
    if (trimmed.length < 1 || trimmed.length > 50) {
      setRenameError('Name must be between 1 and 50 characters');
      return;
    }
    setRenameError(null);
    try {
      await updateStrategyMutation.mutateAsync({
        id: selectedStrategy._id,
        name: trimmed,
      });
      setIsRenameOpen(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to rename strategy';
      setRenameError(msg);
    }
  };

  const handleSaveWeights = async () => {
    if (!selectedStrategy || !isWeightsTotalValid) return;
    try {
      await updateStrategyMutation.mutateAsync({
        id: selectedStrategy._id,
        weights: {
          trend: weights.trend,
          momentum: weights.momentum,
          volume: weights.volume,
          volatility: weights.volatility,
          futures: weights.futures,
          sentiment: weights.sentiment,
          htf: weights.htf ?? 0,
        },
      });
    } catch {
      // Toast handled by mutation
    }
  };

  const handleDeleteStrategy = async () => {
    if (!selectedStrategy) return;
    try {
      await deleteStrategyMutation.mutateAsync(selectedStrategy._id);
      setIsConfirmingDelete(false);
      onSelectedStrategyIdChange(null);
    } catch {
      setIsConfirmingDelete(false);
    }
  };

  const handleWeightChange = (key: keyof SignalWeights, stepPercent: number) => {
    const fraction = Math.round(stepPercent) / 100;
    onConfigChange((prev) => ({
      ...prev,
      weights: {
        ...prev.weights,
        [key]: fraction,
      },
    }));
  };

  const toggleSession = (sess: MarketSession) => {
    const current = config.allowedSessions ?? [...MARKET_SESSIONS];
    let next: MarketSession[];
    if (current.includes(sess)) {
      next = current.filter((s) => s !== sess);
    } else {
      next = [...current, sess];
    }
    onConfigChange((prev) => ({
      ...prev,
      allowedSessions: next.length === MARKET_SESSIONS.length ? undefined : next,
    }));
  };

  const handleEntryThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setEntryThresholdText(raw);
    const { parsed, error } = parseNumberInput(raw);
    setEntryThresholdError(error);
    if (error === null && parsed !== null) {
      onConfigChange((prev) => ({
        ...prev,
        entryThreshold: parsed,
      }));
    }
  };

  const handleExitThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setExitThresholdText(raw);
    const { parsed, error } = parseNumberInput(raw);
    setExitThresholdError(error);
    if (error === null && parsed !== null) {
      onConfigChange((prev) => ({
        ...prev,
        exitThreshold: parsed,
      }));
    }
  };

  const handleShortEntryThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setShortEntryThresholdText(raw);
    const { parsed, error } = parseNumberInput(raw);
    setShortEntryThresholdError(error);
    if (error === null && parsed !== null) {
      onConfigChange((prev) => ({
        ...prev,
        shortEntryThreshold: parsed,
      }));
    }
  };

  const handleShortExitThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setShortExitThresholdText(raw);
    const { parsed, error } = parseNumberInput(raw);
    setShortExitThresholdError(error);
    if (error === null && parsed !== null) {
      onConfigChange((prev) => ({
        ...prev,
        shortExitThreshold: parsed,
      }));
    }
  };

  const handleStopLossChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setStopLossText(raw);
    const { parsed, error } = parseNumberInput(raw, {
      min: 0,
      boundError: 'Must be at least 0.',
    });
    setStopLossError(error);
    if (error === null && parsed !== null) {
      onConfigChange((prev) => ({
        ...prev,
        stopLossPercent: parsed / 100,
      }));
    }
  };

  const handleTakeProfitChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setTakeProfitText(raw);
    const { parsed, error } = parseNumberInput(raw, {
      min: 0,
      boundError: 'Must be at least 0.',
    });
    setTakeProfitError(error);
    if (error === null && parsed !== null) {
      onConfigChange((prev) => ({
        ...prev,
        takeProfitPercent: parsed / 100,
      }));
    }
  };

  const handlePositionSizeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setPositionSizeText(raw);
    const { parsed, error } = parseNumberInput(raw, {
      min: 1,
      max: 100,
      boundError: 'Must be between 1 and 100.',
    });
    setPositionSizeError(error);
    if (error === null && parsed !== null) {
      onConfigChange((prev) => ({
        ...prev,
        positionSizePercent: parsed / 100,
      }));
    }
  };

  const handleFeePercentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setFeePercentText(raw);
    const { parsed, error } = parseNumberInput(raw, {
      min: 0,
      boundError: 'Must be at least 0.',
    });
    setFeePercentError(error);
    if (error === null && parsed !== null) {
      onConfigChange((prev) => ({
        ...prev,
        feePercent: parsed / 100,
      }));
    }
  };

  const handleStartEquityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setStartEquityText(raw);
    const { parsed, error } = parseNumberInput(raw, {
      min: 1,
      boundError: 'Must be at least 1.',
    });
    setStartEquityError(error);
    if (error === null && parsed !== null) {
      onConfigChange((prev) => ({
        ...prev,
        startEquity: parsed,
      }));
    }
  };

  return (
    <div className={cn('bg-card rounded-panel p-5 sm:p-6 border border-line space-y-6', className)}>
      {/* 1. Strategy Selector */}
      <div className="space-y-2">
        <label
          htmlFor={`${idPrefix}-strategy`}
          className="block text-[14px] font-semibold text-foreground"
        >
          Strategy
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <select
            id={`${idPrefix}-strategy`}
            value={selectedStrategyId ?? ''}
            onChange={handleStrategyChange}
            disabled={isLoadingStrategies}
            className="flex-1 min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-semibold text-[14px] focus-visible:outline-3 focus-visible:outline-ring cursor-pointer"
          >
            <option value="">No strategy (run settings on screen)</option>
            {strategies.map((s: Strategy) => (
              <option key={s._id} value={s._id}>
                {s.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            onClick={handleOpenNewStrategy}
            disabled={!isWeightsTotalValid}
            className="min-h-[44px] rounded-[12px] font-semibold text-[14px] px-4"
          >
            New strategy
          </Button>
        </div>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          A strategy saves its coins, intervals and weights. Other settings apply to this run only.
        </p>

        {/* Selected strategy action buttons */}
        {selectedStrategy && (
          <div className="pt-2 flex flex-wrap gap-2 items-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSaveWeights}
              disabled={!isWeightsTotalValid || updateStrategyMutation.isPending}
              className="min-h-[44px] rounded-[12px] text-[13px] font-semibold px-3"
            >
              Save weights to strategy
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleOpenRename}
              className="min-h-[44px] rounded-[12px] text-[13px] font-semibold px-3"
            >
              Rename
            </Button>
            {!isConfirmingDelete ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsConfirmingDelete(true)}
                className="min-h-[44px] rounded-[12px] text-[13px] font-semibold text-down border-edge hover:border-down px-3"
              >
                Delete
              </Button>
            ) : (
              <div className="flex items-center gap-2 p-1 border border-line rounded-[12px]">
                <span className="text-[12px] text-muted-foreground pl-2">Confirm?</span>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleDeleteStrategy}
                  disabled={deleteStrategyMutation.isPending}
                  className="min-h-[44px] rounded-[10px] text-[13px] font-semibold px-3"
                >
                  Delete
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsConfirmingDelete(false)}
                  className="min-h-[44px] rounded-[10px] text-[13px] px-3"
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}

        {!isWeightsTotalValid && (
          <p role="note" className="text-[13px] text-muted-foreground">
            Weights total {totalPercent}%. A strategy needs 100%.
          </p>
        )}
      </div>

      {/* 2. Coin, Interval, and Data Range */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <label
            htmlFor={`${idPrefix}-coin`}
            className="block text-[13px] font-semibold text-foreground"
          >
            Coin
          </label>
          <select
            id={`${idPrefix}-coin`}
            value={symbol}
            onChange={(e) => onSymbolChange(e.target.value)}
            className="w-full min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-semibold text-[14px] focus-visible:outline-3 focus-visible:outline-ring cursor-pointer"
          >
            {VALID_SYMBOLS.map((sym) => (
              <option key={sym} value={sym}>
                {sym.replace(/USDT$/, '')}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor={`${idPrefix}-interval`}
            className="block text-[13px] font-semibold text-foreground"
          >
            Interval
          </label>
          <select
            id={`${idPrefix}-interval`}
            value={interval}
            onChange={(e) => onIntervalChange(e.target.value)}
            className="w-full min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-semibold text-[14px] focus-visible:outline-3 focus-visible:outline-ring cursor-pointer"
          >
            {Object.keys(BINANCE_WS_INTERVALS).map((iv) => (
              <option key={iv} value={iv}>
                {iv}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor={`${idPrefix}-range`}
            className="block text-[13px] font-semibold text-foreground"
          >
            Data range
          </label>
          <select
            id={`${idPrefix}-range`}
            value={dataRange}
            onChange={(e) => onDataRangeChange(e.target.value as DataRange)}
            className="w-full min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-semibold text-[14px] focus-visible:outline-3 focus-visible:outline-ring cursor-pointer"
          >
            {DATA_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 3. Disclosures for Run Settings */}
      <div className="space-y-3 pt-2">
        {/* Disclosure: Thresholds */}
        <details className="group rounded-[14px] border border-line bg-card/60 p-4 open:bg-card">
          <summary className="flex items-center justify-between cursor-pointer font-semibold text-[14px] text-foreground min-h-[44px] select-none">
            <span>Thresholds</span>
            <span className="text-muted-foreground text-[12px] group-open:rotate-180 transition-transform">
              ▼
            </span>
          </summary>
          <div className="pt-3 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label
                  htmlFor={`${idPrefix}-entry-threshold`}
                  className="block text-[13px] font-medium text-foreground"
                >
                  Long entry threshold
                </label>
                <Input
                  id={`${idPrefix}-entry-threshold`}
                  type="number"
                  value={entryThresholdText}
                  onChange={handleEntryThresholdChange}
                  aria-invalid={entryThresholdError !== null}
                  className={cn(
                    'min-h-[44px] rounded-[12px] font-sans tabular-nums text-[14px]',
                    entryThresholdError && 'border-down focus-visible:ring-down'
                  )}
                />
                {entryThresholdError && (
                  <p role="alert" className="text-[12px] text-down">
                    {entryThresholdError}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor={`${idPrefix}-exit-threshold`}
                  className="block text-[13px] font-medium text-foreground"
                >
                  Long exit threshold
                </label>
                <Input
                  id={`${idPrefix}-exit-threshold`}
                  type="number"
                  value={exitThresholdText}
                  onChange={handleExitThresholdChange}
                  aria-invalid={exitThresholdError !== null}
                  className={cn(
                    'min-h-[44px] rounded-[12px] font-sans tabular-nums text-[14px]',
                    exitThresholdError && 'border-down focus-visible:ring-down'
                  )}
                />
                {exitThresholdError && (
                  <p role="alert" className="text-[12px] text-down">
                    {exitThresholdError}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                id={`${idPrefix}-allow-shorts`}
                type="checkbox"
                checked={config.allowShorts}
                onChange={(e) =>
                  onConfigChange((prev) => ({
                    ...prev,
                    allowShorts: e.target.checked,
                  }))
                }
                className="w-5 h-5 rounded cursor-pointer accent-foreground"
              />
              <label
                htmlFor={`${idPrefix}-allow-shorts`}
                className="text-[14px] font-medium text-foreground cursor-pointer select-none"
              >
                Allow shorts
              </label>
            </div>

            {config.allowShorts && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor={`${idPrefix}-short-entry-threshold`}
                    className="block text-[13px] font-medium text-foreground"
                  >
                    Short entry threshold
                  </label>
                  <Input
                    id={`${idPrefix}-short-entry-threshold`}
                    type="number"
                    value={shortEntryThresholdText}
                    onChange={handleShortEntryThresholdChange}
                    aria-invalid={shortEntryThresholdError !== null}
                    className={cn(
                      'min-h-[44px] rounded-[12px] font-sans tabular-nums text-[14px]',
                      shortEntryThresholdError && 'border-down focus-visible:ring-down'
                    )}
                  />
                  {shortEntryThresholdError && (
                    <p role="alert" className="text-[12px] text-down">
                      {shortEntryThresholdError}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor={`${idPrefix}-short-exit-threshold`}
                    className="block text-[13px] font-medium text-foreground"
                  >
                    Short exit threshold
                  </label>
                  <Input
                    id={`${idPrefix}-short-exit-threshold`}
                    type="number"
                    value={shortExitThresholdText}
                    onChange={handleShortExitThresholdChange}
                    aria-invalid={shortExitThresholdError !== null}
                    className={cn(
                      'min-h-[44px] rounded-[12px] font-sans tabular-nums text-[14px]',
                      shortExitThresholdError && 'border-down focus-visible:ring-down'
                    )}
                  />
                  {shortExitThresholdError && (
                    <p role="alert" className="text-[12px] text-down">
                      {shortExitThresholdError}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </details>

        {/* Disclosure: Risk */}
        <details className="group rounded-[14px] border border-line bg-card/60 p-4 open:bg-card">
          <summary className="flex items-center justify-between cursor-pointer font-semibold text-[14px] text-foreground min-h-[44px] select-none">
            <span>Risk</span>
            <span className="text-muted-foreground text-[12px] group-open:rotate-180 transition-transform">
              ▼
            </span>
          </summary>
          <div className="pt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label
                htmlFor={`${idPrefix}-stop-loss`}
                className="block text-[13px] font-medium text-foreground"
              >
                Stop loss (%)
              </label>
              <Input
                id={`${idPrefix}-stop-loss`}
                type="number"
                step="0.5"
                min="0"
                value={stopLossText}
                onChange={handleStopLossChange}
                aria-invalid={stopLossError !== null}
                className={cn(
                  'min-h-[44px] rounded-[12px] font-sans tabular-nums text-[14px]',
                  stopLossError && 'border-down focus-visible:ring-down'
                )}
              />
              {stopLossError && (
                <p role="alert" className="text-[12px] text-down">
                  {stopLossError}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor={`${idPrefix}-take-profit`}
                className="block text-[13px] font-medium text-foreground"
              >
                Take profit (%)
              </label>
              <Input
                id={`${idPrefix}-take-profit`}
                type="number"
                step="0.5"
                min="0"
                value={takeProfitText}
                onChange={handleTakeProfitChange}
                aria-invalid={takeProfitError !== null}
                className={cn(
                  'min-h-[44px] rounded-[12px] font-sans tabular-nums text-[14px]',
                  takeProfitError && 'border-down focus-visible:ring-down'
                )}
              />
              {takeProfitError && (
                <p role="alert" className="text-[12px] text-down">
                  {takeProfitError}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor={`${idPrefix}-position-size`}
                className="block text-[13px] font-medium text-foreground"
              >
                Position size (% equity)
              </label>
              <Input
                id={`${idPrefix}-position-size`}
                type="number"
                step="1"
                min="1"
                max="100"
                value={positionSizeText}
                onChange={handlePositionSizeChange}
                aria-invalid={positionSizeError !== null}
                className={cn(
                  'min-h-[44px] rounded-[12px] font-sans tabular-nums text-[14px]',
                  positionSizeError && 'border-down focus-visible:ring-down'
                )}
              />
              {positionSizeError && (
                <p role="alert" className="text-[12px] text-down">
                  {positionSizeError}
                </p>
              )}
            </div>
          </div>
        </details>

        {/* Disclosure: Costs */}
        <details className="group rounded-[14px] border border-line bg-card/60 p-4 open:bg-card">
          <summary className="flex items-center justify-between cursor-pointer font-semibold text-[14px] text-foreground min-h-[44px] select-none">
            <span>Costs</span>
            <span className="text-muted-foreground text-[12px] group-open:rotate-180 transition-transform">
              ▼
            </span>
          </summary>
          <div className="pt-3 max-w-sm space-y-1.5">
            <label
              htmlFor={`${idPrefix}-fee-percent`}
              className="block text-[13px] font-medium text-foreground"
            >
              Fee per side (%)
            </label>
            <Input
              id={`${idPrefix}-fee-percent`}
              type="number"
              step="0.01"
              min="0"
              value={feePercentText}
              onChange={handleFeePercentChange}
              aria-invalid={feePercentError !== null}
              className={cn(
                'min-h-[44px] rounded-[12px] font-sans tabular-nums text-[14px]',
                feePercentError && 'border-down focus-visible:ring-down'
              )}
            />
            {feePercentError && (
              <p role="alert" className="text-[12px] text-down">
                {feePercentError}
              </p>
            )}
          </div>
        </details>

        {/* Disclosure: Sessions */}
        <details className="group rounded-[14px] border border-line bg-card/60 p-4 open:bg-card">
          <summary className="flex items-center justify-between cursor-pointer font-semibold text-[14px] text-foreground min-h-[44px] select-none">
            <span>Sessions</span>
            <span className="text-muted-foreground text-[12px] group-open:rotate-180 transition-transform">
              ▼
            </span>
          </summary>
          <div className="pt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {MARKET_SESSIONS.map((sess) => {
              const checked =
                !config.allowedSessions ||
                config.allowedSessions.length === 0 ||
                config.allowedSessions.includes(sess);
              return (
                <label
                  key={sess}
                  htmlFor={`${idPrefix}-session-${sess}`}
                  className="flex items-center gap-2 p-2 rounded-[10px] hover:bg-muted/40 cursor-pointer text-[14px] select-none"
                >
                  <input
                    id={`${idPrefix}-session-${sess}`}
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSession(sess)}
                    className="w-5 h-5 rounded cursor-pointer accent-foreground"
                  />
                  <span>{SESSION_LABELS[sess]}</span>
                </label>
              );
            })}
          </div>
        </details>

        {/* Disclosure: Capital */}
        <details className="group rounded-[14px] border border-line bg-card/60 p-4 open:bg-card">
          <summary className="flex items-center justify-between cursor-pointer font-semibold text-[14px] text-foreground min-h-[44px] select-none">
            <span>Capital</span>
            <span className="text-muted-foreground text-[12px] group-open:rotate-180 transition-transform">
              ▼
            </span>
          </summary>
          <div className="pt-3 max-w-sm space-y-1.5">
            <label
              htmlFor={`${idPrefix}-start-equity`}
              className="block text-[13px] font-medium text-foreground"
            >
              Start equity ($)
            </label>
            <Input
              id={`${idPrefix}-start-equity`}
              type="number"
              min="1"
              step="100"
              value={startEquityText}
              onChange={handleStartEquityChange}
              aria-invalid={startEquityError !== null}
              className={cn(
                'min-h-[44px] rounded-[12px] font-sans tabular-nums text-[14px]',
                startEquityError && 'border-down focus-visible:ring-down'
              )}
            />
            {startEquityError && (
              <p role="alert" className="text-[12px] text-down">
                {startEquityError}
              </p>
            )}
          </div>
        </details>

        {/* Disclosure: Weights */}
        <details className="group rounded-[14px] border border-line bg-card/60 p-4 open:bg-card">
          <summary className="flex items-center justify-between cursor-pointer font-semibold text-[14px] text-foreground min-h-[44px] select-none">
            <span>Weights</span>
            <span className="text-muted-foreground text-[12px] group-open:rotate-180 transition-transform">
              ▼
            </span>
          </summary>
          <div className="pt-3 space-y-4">
            <div className="space-y-3">
              {WEIGHT_KEYS.map((key) => {
                const val = weights[key] ?? 0;
                const pct = Math.round(val * 100);
                return (
                  <div key={key} className="space-y-1">
                    <div className="flex justify-between items-center text-[13px]">
                      <label
                        htmlFor={`${idPrefix}-weight-${key}`}
                        className="font-medium text-foreground cursor-pointer"
                      >
                        {WEIGHT_LABELS[key]}
                      </label>
                      <span className="font-sans tabular-nums font-semibold text-foreground">
                        {pct}%
                      </span>
                    </div>
                    <input
                      id={`${idPrefix}-weight-${key}`}
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={pct}
                      onChange={(e) => handleWeightChange(key, Number(e.target.value))}
                      className="w-full min-h-[44px] cursor-pointer accent-foreground"
                    />
                  </div>
                );
              })}
            </div>

            <div className="pt-2 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-t border-line">
              <div className="font-sans tabular-nums font-semibold text-[14px] text-foreground">
                Total: {totalPercent}%
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  onConfigChange((prev) => ({
                    ...prev,
                    weights: DEFAULT_WEIGHTS,
                  }))
                }
                className="min-h-[44px] rounded-[12px] text-[13px] font-semibold px-4"
              >
                Reset to defaults
              </Button>
            </div>
          </div>
        </details>
      </div>

      {/* New Strategy Modal */}
      <Dialog open={isNewOpen} onOpenChange={setIsNewOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[18px] font-semibold text-foreground">New strategy</DialogTitle>
            <DialogDescription>A strategy saves its coins, intervals and weights.</DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <form onSubmit={handleCreateStrategySubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor={`${idPrefix}-new-name`}
                  className="block text-[13px] font-semibold text-foreground"
                >
                  Strategy name
                </label>
                <Input
                  id={`${idPrefix}-new-name`}
                  type="text"
                  maxLength={50}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Trend Momentum 1h"
                  required
                  className="min-h-[44px] rounded-[12px] text-[14px]"
                />
              </div>

              {/* Coins multi-select (1 to 5) */}
              <fieldset className="m-0 min-w-0 space-y-1.5 border-0 p-0">
                <legend className="mb-1.5 block p-0 text-[13px] font-semibold text-foreground">
                  Coins (1 to 5)
                </legend>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {VALID_SYMBOLS.map((sym) => {
                    const isChecked = newSymbols.includes(sym);
                    return (
                      <label
                        key={sym}
                        className={cn(
                          'inline-flex items-center gap-2 min-h-[44px] px-1 rounded-[10px] border border-edge/40 text-[13px] cursor-pointer select-none',
                          isChecked ? 'bg-muted border-edge font-semibold' : 'hover:bg-muted/30'
                        )}
                      >
                        <input
                          type="checkbox"
                          value={sym}
                          checked={isChecked}
                          onChange={() => {
                            if (isChecked) {
                              setNewSymbols(newSymbols.filter((s) => s !== sym));
                            } else if (newSymbols.length < 5) {
                              setNewSymbols([...newSymbols, sym]);
                            }
                          }}
                          className="w-5 h-5 rounded cursor-pointer accent-foreground"
                        />
                        <span>{sym.replace(/USDT$/, '')}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {/* Intervals multi-select (at least 1) */}
              <fieldset className="m-0 min-w-0 space-y-1.5 border-0 p-0">
                <legend className="mb-1.5 block p-0 text-[13px] font-semibold text-foreground">
                  Intervals (at least one)
                </legend>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {VALID_INTERVALS.map((iv) => {
                    const isChecked = newIntervals.includes(iv);
                    return (
                      <label
                        key={iv}
                        className={cn(
                          'inline-flex items-center gap-2 min-h-[44px] px-1 rounded-[10px] border border-edge/40 text-[13px] cursor-pointer select-none',
                          isChecked ? 'bg-muted border-edge font-semibold' : 'hover:bg-muted/30'
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {
                            if (isChecked) {
                              setNewIntervals(newIntervals.filter((i) => i !== iv));
                            } else {
                              setNewIntervals([...newIntervals, iv]);
                            }
                          }}
                          className="w-5 h-5 rounded cursor-pointer accent-foreground"
                        />
                        <span>{iv}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {/* Weights review */}
              <div className="p-3 bg-muted/40 rounded-[12px] space-y-1">
                <span className="text-[12px] font-semibold text-muted-foreground block">
                  Current run weights ({totalPercent}%)
                </span>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12px] font-sans tabular-nums text-foreground">
                  {WEIGHT_KEYS.map((k) => (
                    <div key={k} className="flex justify-between">
                      <span>{WEIGHT_LABELS[k]}:</span>
                      <span>{Math.round((weights[k] ?? 0) * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>

              {newError && (
                <p role="alert" className="text-[13px] text-down">
                  {newError}
                </p>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsNewOpen(false)}
                  className="min-h-[44px] rounded-[12px] text-[14px]"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={createStrategyMutation.isPending}
                  className="min-h-[44px] rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold text-[14px] px-5"
                >
                  {createStrategyMutation.isPending ? 'Creating...' : 'Create strategy'}
                </Button>
              </div>
            </form>
          </div>
        </DialogContent>
      </Dialog>

      {/* Rename Modal */}
      <Dialog open={isRenameOpen} onOpenChange={setIsRenameOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[18px] font-semibold text-foreground">Rename strategy</DialogTitle>
            <DialogDescription>Choose a new name for this strategy.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <form onSubmit={handleRenameSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor={`${idPrefix}-rename-input`}
                  className="block text-[13px] font-semibold text-foreground"
                >
                  New name
                </label>
                <Input
                  id={`${idPrefix}-rename-input`}
                  type="text"
                  maxLength={50}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  required
                  className="min-h-[44px] rounded-[12px] text-[14px]"
                />
              </div>

              {renameError && (
                <p role="alert" className="text-[13px] text-down">
                  {renameError}
                </p>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsRenameOpen(false)}
                  className="min-h-[44px] rounded-[12px] text-[14px]"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={updateStrategyMutation.isPending}
                  className="min-h-[44px] rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold text-[14px] px-5"
                >
                  {updateStrategyMutation.isPending ? 'Saving...' : 'Rename'}
                </Button>
              </div>
            </form>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
