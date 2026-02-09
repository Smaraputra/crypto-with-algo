import { z } from 'zod';
import type { BacktestConfig, BacktestMetrics, BacktestTrade, EquityPoint } from '@/lib/backtest/types';

export const saveBacktestResultSchema = z.object({
  strategyId: z.string().optional(),
  symbol: z.string().min(1, 'Symbol is required'),
  interval: z.string().min(1, 'Interval is required'),
  config: z.record(z.string(), z.unknown()),
  metrics: z.record(z.string(), z.unknown()),
  trades: z.array(z.record(z.string(), z.unknown())),
  equityCurve: z.array(z.record(z.string(), z.unknown())),
  totalBars: z.number().int().positive(),
  warmupBars: z.number().int().min(0),
  startTime: z.number().int().positive(),
  endTime: z.number().int().positive(),
});

export type SaveBacktestResultInput = z.infer<typeof saveBacktestResultSchema>;

export interface SavedBacktestResult {
  _id: string;
  userId: string;
  strategyId: string | null;
  symbol: string;
  interval: string;
  config: BacktestConfig;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  totalBars: number;
  warmupBars: number;
  startTime: number;
  endTime: number;
  createdAt: string;
  updatedAt: string;
}

/** List response omits equityCurve and trades for size */
export interface BacktestResultSummary {
  _id: string;
  userId: string;
  strategyId: string | null;
  symbol: string;
  interval: string;
  metrics: BacktestMetrics;
  totalBars: number;
  startTime: number;
  endTime: number;
  createdAt: string;
}

export interface BacktestResultListResponse {
  results: BacktestResultSummary[];
}

export interface BacktestResultDetailResponse {
  result: SavedBacktestResult;
}
