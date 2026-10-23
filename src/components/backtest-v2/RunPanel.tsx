'use client';

import React, { useState, useEffect } from 'react';
import type { OHLCV } from '@/types/market';
import type { BacktestConfig } from '@/lib/backtest/types';
import type { SnapshotBar } from '@/lib/backtest/snapshot-series';
import type { HtfInput } from '@/lib/backtest/optimized-engine';
import type { BacktestStatus } from '@/hooks/useBacktest';
import type { DataRange } from '@/lib/backtest/options';
import { loadBacktestInputs } from '@/lib/backtest/load-inputs';
import { formatDataStatusDate } from './StrategyConfig';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface RunPanelProps {
  symbol: string;
  interval: string;
  dataRange: DataRange;
  config: BacktestConfig;
  status: BacktestStatus;
  progress: number;
  barsProcessed: number;
  totalBars: number;
  onRun: (
    candles: OHLCV[],
    config: BacktestConfig,
    symbol: string,
    interval: string,
    snapshots?: (SnapshotBar | null)[],
    htfInput?: HtfInput
  ) => void;
  onCancel: () => void;
  onDataRefreshed?: () => void;
  disabled?: boolean;
  className?: string;
}

export const RunPanel: React.FC<RunPanelProps> = ({
  symbol,
  interval,
  dataRange,
  config,
  status,
  progress,
  barsProcessed,
  totalBars,
  onRun,
  onCancel,
  onDataRefreshed,
  disabled = false,
  className,
}) => {
  const [isLoadingInputs, setIsLoadingInputs] = useState(false);
  const [loaderMessage, setLoaderMessage] = useState<string | null>(null);
  const [loaderReason, setLoaderReason] = useState<'fetch_failed' | 'insufficient' | null>(null);
  const [notices, setNotices] = useState<string[]>([]);

  // Candle range data status
  const [isStatusLoading, setIsStatusLoading] = useState(true);
  const [dataStatus, setDataStatus] = useState<string>('n/a');
  const [dataRefreshCount, setDataRefreshCount] = useState(0);

  // Download / Backfill state
  const [isDownloading, setIsDownloading] = useState(false);
  const [backfillFeedback, setBackfillFeedback] = useState<{
    message: string;
    isError: boolean;
  } | null>(null);

  const currentPairKey = `${symbol}:${interval}`;
  const [prevPairKey, setPrevPairKey] = useState(currentPairKey);
  if (prevPairKey !== currentPairKey) {
    setPrevPairKey(currentPairKey);
    setIsStatusLoading(true);
  }

  const selectionKey = `${symbol}:${interval}:${dataRange}`;
  const [prevSelectionKey, setPrevSelectionKey] = useState(selectionKey);
  if (prevSelectionKey !== selectionKey) {
    setPrevSelectionKey(selectionKey);
    setLoaderMessage(null);
    setLoaderReason(null);
    setNotices([]);
  }

  useEffect(() => {
    let isMounted = true;
    fetch(`/api/candles/range?symbol=${symbol}&interval=${interval}`)
      .then((res) => {
        if (!res.ok) throw new Error('Range fetch failed');
        return res.json();
      })
      .then((data) => {
        if (!isMounted) return;
        if (!data || !data.count || data.count === 0 || data.oldest == null || data.newest == null) {
          setDataStatus('n/a');
        } else {
          const oldestStr = formatDataStatusDate(data.oldest);
          const newestStr = formatDataStatusDate(data.newest);
          setDataStatus(`Stored history: ${data.count.toLocaleString('en-US')} bars, ${oldestStr} to ${newestStr}`);
        }
      })
      .catch(() => {
        if (isMounted) setDataStatus('n/a');
      })
      .finally(() => {
        if (isMounted) setIsStatusLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [symbol, interval, dataRefreshCount]);

  const handleDownloadHistory = async () => {
    setIsDownloading(true);
    setBackfillFeedback(null);
    try {
      const res = await fetch('/api/candles/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, interval, months: 24 }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setBackfillFeedback({
          message: data.error || 'Backfill failed',
          isError: true,
        });
      } else {
        setBackfillFeedback({
          message: `Loaded ${data.inserted} new bars (${data.total} stored)`,
          isError: false,
        });
        setDataRefreshCount((c) => c + 1);
        onDataRefreshed?.();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Backfill failed';
      setBackfillFeedback({
        message: msg,
        isError: true,
      });
    } finally {
      setIsDownloading(false);
    }
  };

  const handleRun = async () => {
    setIsLoadingInputs(true);
    setLoaderMessage(null);
    setLoaderReason(null);
    setNotices([]);
    try {
      const inputs = await loadBacktestInputs({ symbol, interval, dataRange });
      if (!inputs.ok) {
        setLoaderReason(inputs.reason);
        setLoaderMessage(inputs.message);
        setIsLoadingInputs(false);
        return;
      }
      setNotices(inputs.notices || []);
      setIsLoadingInputs(false);
      onRun(inputs.klines, config, symbol, interval, inputs.snapshots, inputs.htfInput);
    } catch (err: unknown) {
      setIsLoadingInputs(false);
      const msg = err instanceof Error ? err.message : 'Failed to load backtest data';
      setLoaderMessage(msg);
      setLoaderReason('fetch_failed');
    }
  };

  const isRunning = status === 'running';

  return (
    <div className={cn('bg-card rounded-panel p-5 sm:p-6 border border-line space-y-5', className)}>
      {/* Data status and download button */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 bg-muted/30 rounded-[14px] border border-line">
        {isStatusLoading ? (
          <span
            data-testid="data-status-line"
            className="inline-block h-4 w-48 rounded bg-muted animate-pulse motion-reduce:animate-none"
            aria-label="Loading stored history"
          />
        ) : (
          <span
            data-testid="data-status-line"
            className="text-[13px] text-muted-foreground font-sans tabular-nums"
          >
            {dataStatus}
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleDownloadHistory}
          disabled={isDownloading || isRunning || isLoadingInputs}
          className="min-h-[44px] rounded-[12px] text-[13px] font-semibold px-4 whitespace-nowrap self-stretch sm:self-auto"
        >
          {isDownloading ? 'Downloading...' : 'Download 24 months of history'}
        </Button>
      </div>

      {/* Backfill feedback line */}
      {backfillFeedback && (
        <div
          role={backfillFeedback.isError ? 'alert' : 'status'}
          className={cn(
            'text-[13px] leading-relaxed',
            backfillFeedback.isError ? 'text-down' : 'text-foreground font-medium'
          )}
        >
          {backfillFeedback.message}
        </div>
      )}

      {/* Main Action Area */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={handleRun}
          disabled={isRunning || isLoadingInputs || disabled}
          className="min-h-[44px] rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold text-[15px] px-8 cursor-pointer"
        >
          {isLoadingInputs ? 'Loading data...' : 'Run backtest'}
        </Button>

        {isRunning && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            className="min-h-[44px] rounded-[12px] font-semibold text-[14px] px-5 border-edge hover:border-foreground"
          >
            Stop
          </Button>
        )}
      </div>

      {/* Progress Bar */}
      {isRunning && (
        <div className="space-y-2 pt-1">
          <div className="flex justify-between items-center text-[13px] text-muted-foreground font-sans tabular-nums">
            <span>
              Processed {barsProcessed} of {totalBars} bars
            </span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
            className="w-full bg-muted rounded-full h-2.5 overflow-hidden"
          >
            <div
              className="bg-foreground h-2.5 rounded-full transition-all duration-150"
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </div>
        </div>
      )}

      {/* Inline Loader Notices */}
      {notices.length > 0 && (
        <div className="space-y-1 pt-1">
          {notices.map((notice) => (
            <p key={notice} className="text-[13px] text-muted-foreground leading-relaxed">
              {notice}
            </p>
          ))}
        </div>
      )}

      {/* Inline Loader Message / Insufficient History Offer */}
      {loaderMessage && (
        <div className="space-y-3 pt-1">
          <p role="alert" className="text-[13px] text-down leading-relaxed">
            {loaderMessage}
          </p>

          {loaderReason === 'insufficient' && (
            <div className="p-3 bg-muted/40 rounded-[12px] border border-line flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <span className="text-[13px] text-foreground font-medium">
                Download history to run tests on this range.
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDownloadHistory}
                disabled={isDownloading || isRunning || isLoadingInputs}
                className="min-h-[44px] rounded-[12px] text-[13px] font-semibold px-4 whitespace-nowrap"
              >
                {isDownloading ? 'Downloading...' : 'Download 24 months of history'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
