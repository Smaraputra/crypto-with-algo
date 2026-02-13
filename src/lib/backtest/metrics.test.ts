// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { computeMetrics } from './metrics';
import type { BacktestTrade, EquityPoint } from './types';

function makeTrade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    entryBar: 0,
    exitBar: 1,
    entryTime: 1000,
    exitTime: 2000,
    side: 'long',
    entryPrice: 100,
    exitPrice: 110,
    quantity: 1,
    pnl: 10,
    pnlPercent: 10,
    fees: 0.2,
    exitReason: 'signal',
    entryScore: 40,
    exitScore: -15,
    entryTier: 'buy',
    holdTimeBars: 1,
    ...overrides,
  };
}

describe('computeMetrics', () => {
  it('handles zero trades', () => {
    const metrics = computeMetrics([], [], 10000);

    expect(metrics.totalTrades).toBe(0);
    expect(metrics.totalPnl).toBe(0);
    expect(metrics.winRate).toBe(0);
    expect(metrics.profitFactor).toBe(0);
    expect(metrics.maxDrawdown).toBe(0);
  });

  it('computes basic metrics for winning trades', () => {
    const trades = [
      makeTrade({ pnl: 100, pnlPercent: 10, fees: 1 }),
      makeTrade({ pnl: 50, pnlPercent: 5, fees: 0.5 }),
    ];
    const curve: EquityPoint[] = [
      { bar: 0, time: 1000, equity: 10100, drawdown: 0 },
      { bar: 1, time: 2000, equity: 10150, drawdown: 0 },
    ];

    const metrics = computeMetrics(trades, curve, 10000);

    expect(metrics.totalTrades).toBe(2);
    expect(metrics.winningTrades).toBe(2);
    expect(metrics.losingTrades).toBe(0);
    expect(metrics.winRate).toBe(1);
    expect(metrics.totalPnl).toBeCloseTo(150);
    expect(metrics.totalPnlPercent).toBeCloseTo(1.5);
    expect(metrics.avgWin).toBeCloseTo(75);
    expect(metrics.avgWinPercent).toBeCloseTo(7.5);
    expect(metrics.totalFees).toBeCloseTo(1.5);
  });

  it('computes profit factor with mixed results', () => {
    const trades = [
      makeTrade({ pnl: 200, pnlPercent: 20 }),
      makeTrade({ pnl: -50, pnlPercent: -5 }),
      makeTrade({ pnl: -30, pnlPercent: -3 }),
    ];
    const curve: EquityPoint[] = [
      { bar: 0, time: 1000, equity: 10200, drawdown: 0 },
      { bar: 1, time: 2000, equity: 10150, drawdown: 0.5 },
      { bar: 2, time: 3000, equity: 10120, drawdown: 0.8 },
    ];

    const metrics = computeMetrics(trades, curve, 10000);

    expect(metrics.winRate).toBeCloseTo(1 / 3);
    expect(metrics.profitFactor).toBeCloseTo(200 / 80);
    expect(metrics.avgLoss).toBeCloseTo(40); // (50+30)/2
  });

  it('computes max drawdown', () => {
    const curve: EquityPoint[] = [
      { bar: 0, time: 1000, equity: 10000, drawdown: 0 },
      { bar: 1, time: 2000, equity: 11000, drawdown: 0 },
      { bar: 2, time: 3000, equity: 9500, drawdown: 0 },
      { bar: 3, time: 4000, equity: 10500, drawdown: 0 },
    ];

    const metrics = computeMetrics([], curve, 10000);

    // Peak was 11000, trough 9500 = drawdown 1500
    expect(metrics.maxDrawdown).toBeCloseTo(1500);
    expect(metrics.maxDrawdownPercent).toBeCloseTo((1500 / 11000) * 100);
  });

  it('computes consecutive wins and losses', () => {
    const trades = [
      makeTrade({ pnl: 10 }),
      makeTrade({ pnl: 20 }),
      makeTrade({ pnl: 30 }),
      makeTrade({ pnl: -10 }),
      makeTrade({ pnl: -5 }),
      makeTrade({ pnl: 15 }),
    ];

    const metrics = computeMetrics(trades, [], 10000);

    expect(metrics.maxConsecutiveWins).toBe(3);
    expect(metrics.maxConsecutiveLosses).toBe(2);
  });

  it('computes Sharpe ratio for positive returns', () => {
    const curve: EquityPoint[] = Array.from({ length: 30 }, (_, i) => ({
      bar: i,
      time: i * 1000,
      equity: 10000 + i * 50, // steady positive returns
      drawdown: 0,
    }));

    const metrics = computeMetrics([], curve, 10000);

    // Sharpe should be positive for consistently positive returns
    expect(metrics.sharpeRatio).toBeGreaterThan(0);
  });

  it('computes Calmar ratio', () => {
    const trades = [makeTrade({ pnl: 1000 })];
    const curve: EquityPoint[] = [
      { bar: 0, time: 1000, equity: 10500, drawdown: 0 },
      { bar: 1, time: 2000, equity: 10000, drawdown: 5 },
      { bar: 2, time: 3000, equity: 11000, drawdown: 0 },
    ];

    const metrics = computeMetrics(trades, curve, 10000);

    // Calmar = totalPnlPercent / maxDrawdownPercent
    expect(metrics.calmarRatio).toBeGreaterThan(0);
  });

  it('handles all-losing trades', () => {
    const trades = [
      makeTrade({ pnl: -50, pnlPercent: -5 }),
      makeTrade({ pnl: -30, pnlPercent: -3 }),
    ];

    const metrics = computeMetrics(trades, [], 10000);

    expect(metrics.winRate).toBe(0);
    expect(metrics.profitFactor).toBe(0);
    expect(metrics.avgWin).toBe(0);
    expect(metrics.avgLoss).toBeCloseTo(40);
  });
});
