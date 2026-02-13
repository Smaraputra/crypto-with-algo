import { describe, it, expect } from 'vitest';
import {
  sampleEquityCurve,
  createTradeSummary,
  compressBacktestResult,
} from './compress-results';
import type { BacktestResult, BacktestTrade, EquityPoint } from './types';

describe('sampleEquityCurve', () => {
  it('should return all points if count <= maxPoints', () => {
    const curve: EquityPoint[] = [
      { bar: 0, time: 1000, equity: 10000, drawdown: 0 },
      { bar: 1, time: 2000, equity: 10050, drawdown: 0 },
      { bar: 2, time: 3000, equity: 10100, drawdown: 0 },
    ];

    const sampled = sampleEquityCurve(curve, 200);
    expect(sampled.length).toBe(3);
    expect(sampled).toEqual([
      { timestamp: 1000, equity: 10000 },
      { timestamp: 2000, equity: 10050 },
      { timestamp: 3000, equity: 10100 },
    ]);
  });

  it('should sample to max 200 points', () => {
    const curve: EquityPoint[] = [];
    for (let i = 0; i < 1000; i++) {
      curve.push({ bar: i, time: 1000 + i * 1000, equity: 10000 + i * 10, drawdown: 0 });
    }

    const sampled = sampleEquityCurve(curve, 200);
    expect(sampled.length).toBeLessThanOrEqual(201); // 200 + potentially last point
    expect(sampled[0].timestamp).toBe(1000);
    expect(sampled[sampled.length - 1].timestamp).toBe(1000 + 999 * 1000);
  });

  it('should always include last point', () => {
    const curve: EquityPoint[] = [];
    for (let i = 0; i < 500; i++) {
      curve.push({ bar: i, time: 1000 + i * 1000, equity: 10000 + i * 10, drawdown: 0 });
    }

    const sampled = sampleEquityCurve(curve, 200);
    const lastOriginal = curve[curve.length - 1];
    const lastSampled = sampled[sampled.length - 1];

    expect(lastSampled.timestamp).toBe(lastOriginal.time);
    expect(lastSampled.equity).toBe(lastOriginal.equity);
  });
});

describe('createTradeSummary', () => {
  it('should handle empty trades array', () => {
    const summary = createTradeSummary([]);
    expect(summary).toEqual({
      totalTrades: 0,
      winningTrades: 0,
      avgHoldTimeBars: 0,
      bestTrade: { pnl: 0, pnlPercent: 0, timestamp: 0 },
      worstTrade: { pnl: 0, pnlPercent: 0, timestamp: 0 },
    });
  });

  it('should calculate trade statistics', () => {
    const trades: BacktestTrade[] = [
      {
        entryBar: 10,
        entryTime: 1000,
        entryPrice: 100,
        exitBar: 15,
        exitTime: 1500,
        exitPrice: 105,
        side: 'long',
        quantity: 1,
        pnl: 5,
        pnlPercent: 5,
        fees: 0,
        entryTier: 'buy',
        exitReason: 'signal',
        entryScore: 50,
        exitScore: 10,
        holdTimeBars: 5,
      },
      {
        entryBar: 20,
        entryTime: 2000,
        entryPrice: 105,
        exitBar: 25,
        exitTime: 2500,
        exitPrice: 102,
        side: 'long',
        quantity: 1,
        pnl: -3,
        pnlPercent: -2.86,
        fees: 0,
        entryTier: 'buy',
        exitReason: 'signal',
        entryScore: 40,
        exitScore: 10,
        holdTimeBars: 5,
      },
      {
        entryBar: 30,
        entryTime: 3000,
        entryPrice: 102,
        exitBar: 40,
        exitTime: 4000,
        exitPrice: 110,
        side: 'long',
        quantity: 1,
        pnl: 8,
        pnlPercent: 7.84,
        fees: 0,
        entryTier: 'buy',
        exitReason: 'signal',
        entryScore: 60,
        exitScore: 5,
        holdTimeBars: 10,
      },
    ];

    const summary = createTradeSummary(trades);

    expect(summary.totalTrades).toBe(3);
    expect(summary.winningTrades).toBe(2);
    expect(summary.avgHoldTimeBars).toBeCloseTo(6.67, 1);
    expect(summary.bestTrade).toEqual({
      pnl: 8,
      pnlPercent: 7.84,
      timestamp: 3000,
    });
    expect(summary.worstTrade).toEqual({
      pnl: -3,
      pnlPercent: -2.86,
      timestamp: 2000,
    });
  });
});

describe('compressBacktestResult', () => {
  it('should compress backtest result', () => {
    const result: BacktestResult = {
      symbol: 'BTCUSDT',
      interval: '1h',
      startTime: 1000,
      endTime: 5000,
      totalBars: 100,
      warmupBars: 50,
      config: {
        startEquity: 10000,
        weights: { trend: 0.25, momentum: 0.25, volume: 0.15, volatility: 0.1, futures: 0.15, sentiment: 0.1 },
      } as never,
      metrics: {
        totalReturn: 10,
        sharpeRatio: 1.5,
        winRate: 0.6,
      } as never,
      trades: [
        {
          entryBar: 10,
          entryTime: 1000,
          entryPrice: 100,
          exitBar: 15,
          exitTime: 1500,
          exitPrice: 105,
          side: 'long',
          quantity: 1,
          pnl: 5,
          pnlPercent: 5,
          fees: 0,
          entryTier: 'buy',
          exitReason: 'signal',
          entryScore: 50,
          exitScore: 10,
          holdTimeBars: 5,
        },
      ],
      equityCurve: [
        { bar: 0, time: 1000, equity: 10000, drawdown: 0 },
        { bar: 1, time: 2000, equity: 10050, drawdown: 0 },
        { bar: 2, time: 3000, equity: 10100, drawdown: 0 },
      ],
    };

    const compressed = compressBacktestResult(
      result,
      'user123',
      'strategy456',
      'day_trading'
    );

    expect(compressed.userId).toBe('user123');
    expect(compressed.strategyId).toBe('strategy456');
    expect(compressed.tradingStyle).toBe('day_trading');
    expect(compressed.symbol).toBe('BTCUSDT');
    expect(compressed.interval).toBe('1h');
    expect(compressed.tradeSummary.totalTrades).toBe(1);
    expect(compressed.tradeSummary.winningTrades).toBe(1);
    expect(compressed.equityCurveSampled.length).toBe(3);
    expect(compressed.optimizationGeneration).toBe(0);
    expect(compressed.isOptimized).toBe(false);
  });

  it('should mark as optimized if generation > 0', () => {
    const result: BacktestResult = {
      symbol: 'BTCUSDT',
      interval: '1h',
      startTime: 1000,
      endTime: 5000,
      totalBars: 100,
      warmupBars: 50,
      config: {} as never,
      metrics: {} as never,
      trades: [],
      equityCurve: [],
    };

    const compressed = compressBacktestResult(
      result,
      'user123',
      'strategy456',
      'day_trading',
      'template789',
      2,
      'parent123'
    );

    expect(compressed.optimizationGeneration).toBe(2);
    expect(compressed.isOptimized).toBe(true);
    expect(compressed.templateId).toBeTruthy();
    expect(compressed.parentResultId).toBeTruthy();
  });
});
