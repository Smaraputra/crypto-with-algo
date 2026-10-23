'use client';

import React from 'react';
import { STYLE_CONFIGS, TRADING_STYLES } from '@/lib/indicators/style-configs';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import type { TradingStyle } from '@/lib/models/signal-template';
import { cn } from '@/lib/utils';

export interface CalibrationFiltersState {
  style: TradingStyle;
  interval: string;
  source: 'composite' | 'llm';
  symbol: string;
  configVersion: string;
  overlapping: boolean;
}

export interface CalibrationFiltersProps {
  filters: CalibrationFiltersState;
  onChange: (next: CalibrationFiltersState) => void;
  availableConfigVersions?: number[];
  className?: string;
}

const STYLE_LABELS: Record<TradingStyle, string> = {
  scalping: 'Scalping',
  day_trading: 'Day trading',
  swing_trading: 'Swing trading',
  position_trading: 'Position trading',
};

export const CalibrationFilters: React.FC<CalibrationFiltersProps> = ({
  filters,
  onChange,
  availableConfigVersions = [],
  className,
}) => {
  const currentPreferredIntervals = STYLE_CONFIGS[filters.style].preferredIntervals;

  const handleStyleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextStyle = e.target.value as TradingStyle;
    const nextPreferred = STYLE_CONFIGS[nextStyle].preferredIntervals;
    const nextInterval = nextPreferred.includes(filters.interval)
      ? filters.interval
      : nextPreferred[0];

    onChange({
      ...filters,
      style: nextStyle,
      interval: nextInterval,
      configVersion: '',
    });
  };

  const handleIntervalChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextInterval = e.target.value;
    onChange({
      ...filters,
      interval: nextInterval,
      configVersion: '',
    });
  };

  const handleSourceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextSource = e.target.value as 'composite' | 'llm';
    onChange({
      ...filters,
      source: nextSource,
    });
  };

  const handleSymbolChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextSymbol = e.target.value;
    onChange({
      ...filters,
      symbol: nextSymbol,
    });
  };

  const handleConfigVersionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextVersion = e.target.value;
    onChange({
      ...filters,
      configVersion: nextVersion,
    });
  };

  const handleOverlappingToggle = () => {
    onChange({
      ...filters,
      overlapping: !filters.overlapping,
    });
  };

  return (
    <div
      className={cn(
        'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 p-4 bg-card rounded-[14px] border border-line items-end',
        className
      )}
    >
      {/* 1. Style */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="style-select" className="text-[13px] font-semibold text-muted-foreground">
          Style
        </label>
        <select
          id="style-select"
          data-testid="style-select"
          value={filters.style}
          onChange={handleStyleChange}
          className="min-h-[44px] rounded-[12px] border border-edge bg-card px-3 py-2 text-[14px] font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground"
        >
          {TRADING_STYLES.map((st) => (
            <option key={st} value={st}>
              {STYLE_LABELS[st]}
            </option>
          ))}
        </select>
      </div>

      {/* 2. Interval */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="interval-select" className="text-[13px] font-semibold text-muted-foreground">
          Interval
        </label>
        <select
          id="interval-select"
          data-testid="interval-select"
          value={filters.interval}
          onChange={handleIntervalChange}
          className="min-h-[44px] rounded-[12px] border border-edge bg-card px-3 py-2 text-[14px] font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground"
        >
          {currentPreferredIntervals.map((iv) => (
            <option key={iv} value={iv}>
              {iv}
            </option>
          ))}
        </select>
      </div>

      {/* 3. Source */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="source-select" className="text-[13px] font-semibold text-muted-foreground">
          Source
        </label>
        <select
          id="source-select"
          data-testid="source-select"
          value={filters.source}
          onChange={handleSourceChange}
          className="min-h-[44px] rounded-[12px] border border-edge bg-card px-3 py-2 text-[14px] font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground"
        >
          <option value="composite">Composite</option>
          <option value="llm">LLM</option>
        </select>
      </div>

      {/* 4. Coin */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="symbol-select" className="text-[13px] font-semibold text-muted-foreground">
          Coin
        </label>
        <select
          id="symbol-select"
          data-testid="symbol-select"
          value={filters.symbol}
          onChange={handleSymbolChange}
          className="min-h-[44px] rounded-[12px] border border-edge bg-card px-3 py-2 text-[14px] font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground"
        >
          <option value="">All coins</option>
          {SIGNAL_SYMBOLS.map((sym) => (
            <option key={sym} value={sym}>
              {sym.replace(/USDT$/, '')}
            </option>
          ))}
        </select>
      </div>

      {/* 5. Config version */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="config-version-select" className="text-[13px] font-semibold text-muted-foreground">
          Config version
        </label>
        <select
          id="config-version-select"
          data-testid="config-version-select"
          value={filters.configVersion}
          onChange={handleConfigVersionChange}
          className="min-h-[44px] rounded-[12px] border border-edge bg-card px-3 py-2 text-[14px] font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground"
        >
          <option value="">All versions</option>
          {availableConfigVersions.map((v) => (
            <option key={v} value={String(v)}>
              v{v}
            </option>
          ))}
        </select>
      </div>

      {/* 6. Overlapping */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="overlapping-toggle" className="text-[13px] font-semibold text-muted-foreground">
          Sampling
        </label>
        <button
          id="overlapping-toggle"
          type="button"
          role="switch"
          aria-checked={filters.overlapping}
          data-testid="overlapping-toggle"
          onClick={handleOverlappingToggle}
          className={cn(
            'min-h-[44px] px-4 rounded-[12px] font-semibold text-[14px] transition-colors border flex items-center justify-center',
            filters.overlapping
              ? 'bg-foreground text-background border-foreground'
              : 'bg-card text-foreground border-edge hover:bg-muted/30'
          )}
        >
          {filters.overlapping ? 'Overlapping' : 'Non-overlapping'}
        </button>
      </div>
    </div>
  );
};
