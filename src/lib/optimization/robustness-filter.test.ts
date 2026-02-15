import { describe, it, expect } from 'vitest';
import { isRobust, filterRobustResults, getRobustnessScore } from './robustness-filter';
import type { IBacktestResultV2 } from '@/lib/models/backtest-result-v2';

describe('robustness-filter', () => {
  const createMockResult = (overrides: {
    sharpeRatio?: number;
    winRate?: number;
    maxDrawdown?: number;
    totalTrades?: number;
  }): IBacktestResultV2 => {
    const metrics: Record<string, number | undefined> = {};

    // Only set metrics if explicitly provided (allow undefined to pass through)
    if ('sharpeRatio' in overrides) {
      metrics.sharpeRatio = overrides.sharpeRatio;
    } else {
      metrics.sharpeRatio = 1.0;
    }

    if ('winRate' in overrides) {
      metrics.winRate = overrides.winRate;
    } else {
      metrics.winRate = 0.5;
    }

    if ('maxDrawdown' in overrides) {
      metrics.maxDrawdown = overrides.maxDrawdown;
    } else {
      metrics.maxDrawdown = -0.2;
    }

    return {
      metrics,
      tradeSummary: {
        totalTrades: overrides.totalTrades ?? 20,
        winningTrades: Math.floor((overrides.totalTrades ?? 20) * (overrides.winRate ?? 0.5)),
        avgHoldTimeBars: 5,
        bestTrade: { pnl: 100, pnlPercent: 5, timestamp: 0 },
        worstTrade: { pnl: -50, pnlPercent: -2.5, timestamp: 0 },
      },
    } as unknown as IBacktestResultV2;
  };

  describe('isRobust', () => {
    it('passes robust result', () => {
      const result = createMockResult({
        sharpeRatio: 1.0,
        winRate: 0.5,
        maxDrawdown: -0.2,
        totalTrades: 20,
      });

      expect(isRobust(result)).toBe(true);
    });

    it('rejects low Sharpe ratio', () => {
      const result = createMockResult({
        sharpeRatio: 0.3, // Below 0.5 threshold
        winRate: 0.5,
        maxDrawdown: -0.2,
        totalTrades: 20,
      });

      expect(isRobust(result)).toBe(false);
    });

    it('rejects low win rate', () => {
      const result = createMockResult({
        sharpeRatio: 1.0,
        winRate: 0.3, // Below 0.4 threshold
        maxDrawdown: -0.2,
        totalTrades: 20,
      });

      expect(isRobust(result)).toBe(false);
    });

    it('rejects high drawdown', () => {
      const result = createMockResult({
        sharpeRatio: 1.0,
        winRate: 0.5,
        maxDrawdown: -0.4, // Worse than -0.3 threshold
        totalTrades: 20,
      });

      expect(isRobust(result)).toBe(false);
    });

    it('rejects too few trades', () => {
      const result = createMockResult({
        sharpeRatio: 1.0,
        winRate: 0.5,
        maxDrawdown: -0.2,
        totalTrades: 5, // Below 10 threshold
      });

      expect(isRobust(result)).toBe(false);
    });

    it('treats missing Sharpe ratio as failing robustness', () => {
      const result = createMockResult({
        sharpeRatio: undefined,
        winRate: 0.5,
        maxDrawdown: -0.2,
        totalTrades: 20,
      });

      // undefined sharpe becomes -Infinity, which IS less than minSharpe,
      // so it's treated as very bad and FAILS robustness
      // Wait, -Infinity < 0.5 is TRUE, so it should pass this check
      // But -Infinity is a bad value logically. Let me check...
      // Actually -Infinity < 0.5 returns true, so the sharpe check passes
      // But we want undefined to fail. Need to fix the implementation.
      expect(isRobust(result)).toBe(false);
    });

    it('uses custom config', () => {
      const result = createMockResult({
        sharpeRatio: 0.3,
        winRate: 0.5,
        maxDrawdown: -0.2,
        totalTrades: 20,
      });

      const customConfig = {
        minSharpe: 0.2, // Lower threshold
        minWinRate: 0.4,
        maxDrawdown: 0.3,
        minTrades: 10,
      };

      expect(isRobust(result, customConfig)).toBe(true);
    });
  });

  describe('filterRobustResults', () => {
    it('filters out non-robust results', () => {
      const results = [
        createMockResult({ sharpeRatio: 1.0, winRate: 0.5, totalTrades: 20 }), // Robust
        createMockResult({ sharpeRatio: 0.3, winRate: 0.5, totalTrades: 20 }), // Not robust (low Sharpe)
        createMockResult({ sharpeRatio: 1.0, winRate: 0.3, totalTrades: 20 }), // Not robust (low win rate)
        createMockResult({ sharpeRatio: 1.5, winRate: 0.6, totalTrades: 30 }), // Robust
      ];

      const filtered = filterRobustResults(results);
      expect(filtered).toHaveLength(2);
      expect((filtered[0].metrics as { sharpeRatio: number }).sharpeRatio).toBe(1.0);
      expect((filtered[1].metrics as { sharpeRatio: number }).sharpeRatio).toBe(1.5);
    });

    it('returns empty array when no results are robust', () => {
      const results = [
        createMockResult({ sharpeRatio: 0.2, winRate: 0.3, totalTrades: 5 }),
        createMockResult({ sharpeRatio: 0.1, winRate: 0.2, totalTrades: 3 }),
      ];

      const filtered = filterRobustResults(results);
      expect(filtered).toHaveLength(0);
    });

    it('returns all results when all are robust', () => {
      const results = [
        createMockResult({ sharpeRatio: 1.0, winRate: 0.5, totalTrades: 20 }),
        createMockResult({ sharpeRatio: 1.5, winRate: 0.6, totalTrades: 30 }),
        createMockResult({ sharpeRatio: 2.0, winRate: 0.7, totalTrades: 40 }),
      ];

      const filtered = filterRobustResults(results);
      expect(filtered).toHaveLength(3);
    });
  });

  describe('getRobustnessScore', () => {
    it('returns 0 for non-robust result', () => {
      const result = createMockResult({
        sharpeRatio: 0.2,
        winRate: 0.3,
        totalTrades: 5,
      });

      expect(getRobustnessScore(result)).toBe(0);
    });

    it('returns positive score for robust result', () => {
      const result = createMockResult({
        sharpeRatio: 1.0,
        winRate: 0.5,
        maxDrawdown: -0.2,
        totalTrades: 20,
      });

      const score = getRobustnessScore(result);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('ranks better results higher', () => {
      const good = createMockResult({
        sharpeRatio: 2.0,
        winRate: 0.7,
        maxDrawdown: -0.1,
        totalTrades: 50,
      });

      const okay = createMockResult({
        sharpeRatio: 0.8,
        winRate: 0.45,
        maxDrawdown: -0.25,
        totalTrades: 15,
      });

      expect(getRobustnessScore(good)).toBeGreaterThan(getRobustnessScore(okay));
    });

    it('caps scores at 1.0', () => {
      const excellent = createMockResult({
        sharpeRatio: 10.0, // Very high
        winRate: 1.0, // Perfect
        maxDrawdown: -0.01, // Minimal
        totalTrades: 100, // Many trades
      });

      const score = getRobustnessScore(excellent);
      expect(score).toBeLessThanOrEqual(1.0);
    });
  });
});
