import type { Strategy, CreateStrategyInput } from '@/types/strategy';
import type { SignalWeights } from '@/types/signal';

export const mockWeights: SignalWeights = {
  trend: 0.25,
  momentum: 0.25,
  volume: 0.15,
  volatility: 0.10,
  futures: 0.15,
  sentiment: 0.10,
};

export const mockMomentumWeights: SignalWeights = {
  trend: 0.10,
  momentum: 0.40,
  volume: 0.15,
  volatility: 0.10,
  futures: 0.15,
  sentiment: 0.10,
};

export const mockStrategy: Strategy = {
  _id: 'strat-1',
  userId: 'user-1',
  name: 'BTC Momentum',
  symbols: ['BTCUSDT'],
  intervals: ['1h', '4h'],
  weights: mockWeights,
  active: true,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

export const mockStrategy2: Strategy = {
  _id: 'strat-2',
  userId: 'user-1',
  name: 'ETH Trend',
  symbols: ['ETHUSDT', 'BTCUSDT'],
  intervals: ['1h'],
  weights: mockMomentumWeights,
  active: true,
  createdAt: '2025-01-02T00:00:00.000Z',
  updatedAt: '2025-01-02T00:00:00.000Z',
};

export const mockInactiveStrategy: Strategy = {
  _id: 'strat-3',
  userId: 'user-1',
  name: 'Inactive Strategy',
  symbols: ['SOLUSDT'],
  intervals: ['15m'],
  weights: mockWeights,
  active: false,
  createdAt: '2025-01-03T00:00:00.000Z',
  updatedAt: '2025-01-03T00:00:00.000Z',
};

export const mockStrategies: Strategy[] = [
  mockStrategy,
  mockStrategy2,
  mockInactiveStrategy,
];

export const mockCreateStrategyInput: CreateStrategyInput = {
  name: 'New Strategy',
  symbols: ['BTCUSDT'],
  intervals: ['1h'],
  weights: mockWeights,
};

export const mockInvalidWeights: SignalWeights = {
  trend: 0.50,
  momentum: 0.50,
  volume: 0.15,
  volatility: 0.10,
  futures: 0.15,
  sentiment: 0.10,
};
