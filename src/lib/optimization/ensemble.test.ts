import { describe, it, expect } from 'vitest';
import { selectTopPerformers, createEnsemble } from './ensemble';
import type { IBacktestResultV2 } from '@/lib/models/backtest-result-v2';
import type { SignalWeights } from '@/types/signal';

describe('ensemble', () => {
  const createMockResult = (
    sharpe: number,
    winRate: number,
    weights: SignalWeights
  ): IBacktestResultV2 => {
    return {
      metrics: {
        sharpeRatio: sharpe,
        winRate,
        sortino: sharpe * 1.2,
        calmar: sharpe * 0.8,
      },
      config: {
        weights,
      },
      tradeSummary: {
        totalTrades: 20,
        winningTrades: Math.floor(20 * winRate),
        avgHoldTimeBars: 5,
        bestTrade: { pnl: 100, pnlPercent: 5, timestamp: 0 },
        worstTrade: { pnl: -50, pnlPercent: -2.5, timestamp: 0 },
      },
    } as unknown as IBacktestResultV2;
  };

  const weights1: SignalWeights = {
    trend: 0.2,
    momentum: 0.3,
    volume: 0.2,
    volatility: 0.1,
    futures: 0.1,
    sentiment: 0.1,
  };

  const weights2: SignalWeights = {
    trend: 0.3,
    momentum: 0.2,
    volume: 0.2,
    volatility: 0.1,
    futures: 0.1,
    sentiment: 0.1,
  };

  const weights3: SignalWeights = {
    trend: 0.25,
    momentum: 0.25,
    volume: 0.2,
    volatility: 0.1,
    futures: 0.1,
    sentiment: 0.1,
  };

  describe('selectTopPerformers', () => {
    it('selects top N by Sharpe ratio', () => {
      const results = [
        createMockResult(1.0, 0.5, weights1),
        createMockResult(2.0, 0.6, weights2),
        createMockResult(0.5, 0.4, weights3),
      ];

      const top2 = selectTopPerformers(results, 2, 'sharpeRatio');

      expect(top2).toHaveLength(2);
      expect((top2[0].metrics as { sharpeRatio: number }).sharpeRatio).toBe(2.0);
      expect((top2[1].metrics as { sharpeRatio: number }).sharpeRatio).toBe(1.0);
    });

    it('selects top N by Sortino ratio', () => {
      const results = [
        createMockResult(1.0, 0.5, weights1),
        createMockResult(2.0, 0.6, weights2),
        createMockResult(0.5, 0.4, weights3),
      ];

      const top2 = selectTopPerformers(results, 2, 'sortino');

      expect(top2).toHaveLength(2);
      // Sortino = sharpe * 1.2
      expect((top2[0].metrics as { sortino: number }).sortino).toBe(2.4);
      expect((top2[1].metrics as { sortino: number }).sortino).toBe(1.2);
    });

    it('returns all results when count > length', () => {
      const results = [
        createMockResult(1.0, 0.5, weights1),
        createMockResult(2.0, 0.6, weights2),
      ];

      const top5 = selectTopPerformers(results, 5);
      expect(top5).toHaveLength(2);
    });

    it('handles results with missing metrics', () => {
      const results = [
        createMockResult(1.0, 0.5, weights1),
        { ...createMockResult(2.0, 0.6, weights2), metrics: {} } as unknown as IBacktestResultV2, // Missing sharpeRatio
        createMockResult(0.5, 0.4, weights3),
      ];

      const top2 = selectTopPerformers(results, 2);
      expect(top2).toHaveLength(2);
      // Missing metric treated as -Infinity, should be last
      expect((top2[0].metrics as { sharpeRatio: number }).sharpeRatio).toBe(1.0);
    });
  });

  describe('createEnsemble', () => {
    it('creates ensemble from top performers', () => {
      const results = [
        createMockResult(1.0, 0.5, weights1),
        createMockResult(2.0, 0.6, weights2),
        createMockResult(1.5, 0.55, weights3),
      ];

      const ensemble = createEnsemble(results, 2);

      expect(ensemble.contributors).toHaveLength(2);
      expect(ensemble.weights).toBeDefined();
      expect(ensemble.avgSharpe).toBeCloseTo((2.0 + 1.5) / 2);
      expect(ensemble.avgWinRate).toBeCloseTo((0.6 + 0.55) / 2);
    });

    it('averages weights correctly', () => {
      // Create results with known weights
      const result1 = createMockResult(1.0, 0.5, {
        trend: 0.2,
        momentum: 0.2,
        volume: 0.2,
        volatility: 0.2,
        futures: 0.1,
        sentiment: 0.1,
      });

      const result2 = createMockResult(1.5, 0.6, {
        trend: 0.3,
        momentum: 0.3,
        volume: 0.2,
        volatility: 0.1,
        futures: 0.05,
        sentiment: 0.05,
      });

      const ensemble = createEnsemble([result1, result2], 2);

      // Average should be (0.2+0.3)/2 = 0.25 for trend
      expect(ensemble.weights.trend).toBeCloseTo(0.25);
      expect(ensemble.weights.momentum).toBeCloseTo(0.25);
      expect(ensemble.weights.futures).toBeCloseTo(0.075);
    });

    it('throws error for empty results', () => {
      expect(() => createEnsemble([], 5)).toThrow();
    });

    it('handles single result', () => {
      const results = [createMockResult(1.0, 0.5, weights1)];

      const ensemble = createEnsemble(results, 1);

      expect(ensemble.contributors).toHaveLength(1);
      expect(ensemble.weights).toEqual(weights1);
      expect(ensemble.avgSharpe).toBe(1.0);
      expect(ensemble.avgWinRate).toBe(0.5);
    });

    it('selects correct top N when more results exist', () => {
      const results = [
        createMockResult(0.5, 0.4, weights1),
        createMockResult(2.0, 0.7, weights2),
        createMockResult(1.0, 0.5, weights3),
        createMockResult(1.5, 0.6, weights1),
        createMockResult(0.8, 0.45, weights2),
      ];

      const ensemble = createEnsemble(results, 3);

      expect(ensemble.contributors).toHaveLength(3);
      // Top 3 by Sharpe: 2.0, 1.5, 1.0
      expect(ensemble.avgSharpe).toBeCloseTo((2.0 + 1.5 + 1.0) / 3);
    });

    it('includes avgSortino in result', () => {
      const results = [
        createMockResult(1.0, 0.5, weights1),
        createMockResult(2.0, 0.6, weights2),
      ];

      const ensemble = createEnsemble(results, 2);

      // Sortino = sharpe * 1.2
      expect(ensemble.avgSortino).toBeCloseTo((1.2 + 2.4) / 2);
    });
  });
});
