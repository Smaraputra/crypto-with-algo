import { z } from 'zod';
import type { SignalWeights } from '@/types/signal';

export const VALID_INTERVALS = ['15m', '1h', '4h', '1d'] as const;

export const VALID_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
] as const;

const weightsSchema = z.object({
  trend: z.number().min(0).max(1),
  momentum: z.number().min(0).max(1),
  volume: z.number().min(0).max(1),
  volatility: z.number().min(0).max(1),
  futures: z.number().min(0).max(1),
  sentiment: z.number().min(0).max(1),
}).refine(
  (w) => Math.abs(w.trend + w.momentum + w.volume + w.volatility + w.futures + w.sentiment - 1.0) < 0.01,
  { message: 'Weights must sum to 1.0' }
);

export const createStrategySchema = z.object({
  name: z.string().min(1, 'Name is required').max(50, 'Name must be 50 characters or less'),
  symbols: z.array(z.string()).min(1, 'At least one symbol is required').max(5, 'Maximum 5 symbols'),
  intervals: z.array(z.enum(VALID_INTERVALS)).min(1, 'At least one interval is required'),
  weights: weightsSchema,
  active: z.boolean().optional(),
});

export const updateStrategySchema = createStrategySchema.partial();

export type CreateStrategyInput = z.infer<typeof createStrategySchema>;
export type UpdateStrategyInput = z.infer<typeof updateStrategySchema>;

export interface Strategy {
  _id: string;
  userId: string;
  name: string;
  symbols: string[];
  intervals: string[];
  weights: SignalWeights;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyListResponse {
  strategies: Strategy[];
}

export interface StrategyResponse {
  strategy: Strategy;
}
