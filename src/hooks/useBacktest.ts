'use client';

import { useState, useCallback, useRef } from 'react';
import type { OHLCV } from '@/types/market';
import type { BacktestConfig, BacktestResult } from '@/lib/backtest/types';
import type { WorkerRequest, WorkerResponse } from '@/lib/backtest/worker-types';

export type BacktestStatus = 'idle' | 'running' | 'complete' | 'error';

export interface UseBacktestReturn {
  status: BacktestStatus;
  progress: number;
  barsProcessed: number;
  totalBars: number;
  result: BacktestResult | null;
  error: string | null;
  run: (candles: OHLCV[], config: BacktestConfig, symbol: string, interval: string) => void;
  cancel: () => void;
}

export function useBacktest(): UseBacktestReturn {
  const [status, setStatus] = useState<BacktestStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [barsProcessed, setBarsProcessed] = useState(0);
  const [totalBars, setTotalBars] = useState(0);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const cancel = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setStatus('idle');
    setProgress(0);
    setBarsProcessed(0);
    setTotalBars(0);
  }, []);

  const run = useCallback(
    (candles: OHLCV[], config: BacktestConfig, symbol: string, interval: string) => {
      // Terminate any existing worker
      if (workerRef.current) {
        workerRef.current.terminate();
      }

      setStatus('running');
      setProgress(0);
      setBarsProcessed(0);
      setTotalBars(0);
      setResult(null);
      setError(null);

      const worker = new Worker(
        new URL('../workers/backtest.worker.ts', import.meta.url)
      );
      workerRef.current = worker;

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;

        switch (msg.type) {
          case 'progress':
            setProgress(msg.progress);
            setBarsProcessed(msg.barsProcessed);
            setTotalBars(msg.totalBars);
            break;
          case 'complete':
            setStatus('complete');
            setResult(msg.result);
            setProgress(100);
            worker.terminate();
            workerRef.current = null;
            break;
          case 'error':
            setStatus('error');
            setError(msg.message);
            worker.terminate();
            workerRef.current = null;
            break;
        }
      };

      worker.onerror = (err) => {
        setStatus('error');
        setError(err.message || 'Worker error');
        worker.terminate();
        workerRef.current = null;
      };

      const request: WorkerRequest = {
        type: 'run',
        candles,
        config,
        symbol,
        interval,
      };
      worker.postMessage(request);
    },
    []
  );

  return {
    status,
    progress,
    barsProcessed,
    totalBars,
    result,
    error,
    run,
    cancel,
  };
}
