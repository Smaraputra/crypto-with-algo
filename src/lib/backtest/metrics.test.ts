// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { computeMetrics, computeExpectancy } from './metrics';
import { barsPerYear } from '@/lib/intervals';
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
    riskPercent: 0, // no override qualifies for expectancyR (not above 0); override per test as needed
    rewardPercent: null,
    slippageCost: 0,
    entryFillKind: 'taker',
    exitFillKind: 'taker',
    fundingCost: 0,
    ...overrides,
  };
}

describe('computeMetrics', () => {
  it('handles zero trades', () => {
    const metrics = computeMetrics([], [], 10000, '1d');

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

    const metrics = computeMetrics(trades, curve, 10000, '1d');

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

    const metrics = computeMetrics(trades, curve, 10000, '1d');

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

    const metrics = computeMetrics([], curve, 10000, '1d');

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

    const metrics = computeMetrics(trades, [], 10000, '1d');

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

    const metrics = computeMetrics([], curve, 10000, '1d');

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

    const metrics = computeMetrics(trades, curve, 10000, '1d');

    // Calmar = totalPnlPercent / maxDrawdownPercent
    expect(metrics.calmarRatio).toBeGreaterThan(0);
  });

  it('handles all-losing trades', () => {
    const trades = [
      makeTrade({ pnl: -50, pnlPercent: -5 }),
      makeTrade({ pnl: -30, pnlPercent: -3 }),
    ];

    const metrics = computeMetrics(trades, [], 10000, '1d');

    expect(metrics.winRate).toBe(0);
    expect(metrics.profitFactor).toBe(0);
    expect(metrics.avgWin).toBe(0);
    expect(metrics.avgLoss).toBeCloseTo(40);
  });
});

describe('annualization by interval', () => {
  // A short curve with mixed up/down moves so stdDev and downside deviation
  // are both nonzero (Sharpe/Sortino would be 0 or Infinity otherwise).
  const curve: EquityPoint[] = [
    { bar: 0, time: 0, equity: 10100, drawdown: 0 },
    { bar: 1, time: 1, equity: 10050, drawdown: 0 },
    { bar: 2, time: 2, equity: 10180, drawdown: 0 },
    { bar: 3, time: 3, equity: 10120, drawdown: 0 },
    { bar: 4, time: 4, equity: 10260, drawdown: 0 },
  ];

  it('scales Sharpe by sqrt(barsPerYear) across intervals', () => {
    const hourly = computeMetrics([], curve, 10000, '1h');
    const daily = computeMetrics([], curve, 10000, '1d');

    const expectedRatio = Math.sqrt(barsPerYear('1h') / barsPerYear('1d'));
    expect(hourly.sharpeRatio / daily.sharpeRatio).toBeCloseTo(expectedRatio, 9);
  });

  it('scales Sortino by sqrt(barsPerYear) across intervals', () => {
    const hourly = computeMetrics([], curve, 10000, '1h');
    const daily = computeMetrics([], curve, 10000, '1d');

    const expectedRatio = Math.sqrt(barsPerYear('1h') / barsPerYear('1d'));
    expect(hourly.sortinoRatio / daily.sortinoRatio).toBeCloseTo(expectedRatio, 9);
  });

  it('matches a hand-computed Sharpe ratio at 1d (sample stdDev, sqrt(365))', () => {
    // Returns derived from the curve above, relative to startEquity 10000 then
    // the previous point.
    const startEquity = 10000;
    const equities = curve.map((p) => p.equity);
    const returns: number[] = [];
    let prev = startEquity;
    for (const e of equities) {
      returns.push((e - prev) / prev);
      prev = e;
    }
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    const expectedSharpe = (mean / stdDev) * Math.sqrt(365);

    const metrics = computeMetrics([], curve, startEquity, '1d');
    expect(metrics.sharpeRatio).toBeCloseTo(expectedSharpe, 9);
  });
});

describe('computeExpectancy', () => {
  it('returns 0 and null when there are no trades', () => {
    const result = computeExpectancy([]);
    expect(result.expectancyPercent).toBe(0);
    expect(result.expectancyR).toBeNull();
  });

  it('computes expectancyPercent as the mean pnlPercent across trades', () => {
    const trades = [
      makeTrade({ pnlPercent: 10 }),
      makeTrade({ pnlPercent: -4 }),
      makeTrade({ pnlPercent: 6 }),
    ];

    const result = computeExpectancy(trades);
    expect(result.expectancyPercent).toBeCloseTo((10 - 4 + 6) / 3);
  });

  it('returns expectancyR null when no trade has a finite positive riskPercent', () => {
    const trades = [
      makeTrade({ pnlPercent: 10 }),
      makeTrade({ pnlPercent: -4, riskPercent: 0 }),
    ];

    const result = computeExpectancy(trades);
    expect(result.expectancyR).toBeNull();
  });

  it('computes expectancyR as the mean of pnlPercent/riskPercent over qualifying trades', () => {
    const trades = [
      makeTrade({ pnlPercent: 10, riskPercent: 5 }), // R = 2
      makeTrade({ pnlPercent: -4, riskPercent: 2 }), // R = -2
      makeTrade({ pnlPercent: 6 }), // riskPercent defaults to 0 (not above 0), excluded
      makeTrade({ pnlPercent: 3, riskPercent: 0 }), // riskPercent not above 0, excluded
    ];

    const result = computeExpectancy(trades);
    expect(result.expectancyR).toBeCloseTo((2 + -2) / 2);
  });
});
