import type { OHLCV } from '@/types/market';
import type { BacktestConfig, BacktestResult } from './types';
import type { SnapshotBar } from './snapshot-series';

export interface WorkerRequest {
  type: 'run';
  candles: OHLCV[];
  config: BacktestConfig;
  symbol: string;
  interval: string;
  snapshots?: (SnapshotBar | null)[]; // compact per-bar futures/sentiment series
}

export type WorkerResponse =
  | { type: 'progress'; progress: number; barsProcessed: number; totalBars: number }
  | { type: 'complete'; result: BacktestResult }
  | { type: 'error'; message: string };
