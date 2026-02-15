import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { BacktestResultV2 } from './backtest-result-v2';

function makeValidData(overrides = {}) {
  return {
    userId: 'user-1',
    tradingStyle: 'day_trading',
    symbol: 'BTCUSDT',
    interval: '1h',
    config: { strategy: 'momentum', param: 14 },
    metrics: { sharpeRatio: 1.5, winRate: 0.55 },
    tradeSummary: {
      totalTrades: 100,
      winningTrades: 55,
      avgHoldTimeBars: 12,
      bestTrade: { pnl: 500, pnlPercent: 5, timestamp: 1700050000000 },
      worstTrade: { pnl: -300, pnlPercent: -3, timestamp: 1700060000000 },
    },
    startTime: 1700000000000,
    endTime: 1700100000000,
    totalBars: 500,
    warmupBars: 50,
    ...overrides,
  };
}

describe('BacktestResultV2 model', () => {
  it('validates a document with all required fields', () => {
    const doc = new BacktestResultV2(makeValidData());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default values for optional fields', () => {
    const doc = new BacktestResultV2(makeValidData());
    expect(doc.strategyId).toBeNull();
    expect(doc.templateId).toBeNull();
    expect(doc.equityCurveSampled).toEqual([]);
    expect(doc.optimizationGeneration).toBe(0);
    expect(doc.parentResultId).toBeNull();
    expect(doc.isOptimized).toBe(false);
    expect(doc.contributedToTemplate).toBe(false);
  });

  it('accepts all valid trading styles', () => {
    const styles = ['scalping', 'day_trading', 'swing_trading', 'position_trading'];
    for (const style of styles) {
      const doc = new BacktestResultV2(makeValidData({ tradingStyle: style }));
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.tradingStyle).toBe(style);
    }
  });

  it('rejects invalid trading style', () => {
    const doc = new BacktestResultV2(makeValidData({ tradingStyle: 'invalid_style' }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('tradingStyle');
  });

  it('accepts templateId as ObjectId', () => {
    const id = new mongoose.Types.ObjectId();
    const doc = new BacktestResultV2(makeValidData({ templateId: id }));
    expect(doc.templateId?.toString()).toBe(id.toString());
  });

  it('accepts parentResultId as ObjectId', () => {
    const id = new mongoose.Types.ObjectId();
    const doc = new BacktestResultV2(makeValidData({ parentResultId: id }));
    expect(doc.parentResultId?.toString()).toBe(id.toString());
  });

  it('accepts equityCurveSampled array', () => {
    const curve = [
      { timestamp: 1700000000000, equity: 10000 },
      { timestamp: 1700050000000, equity: 10500 },
    ];
    const doc = new BacktestResultV2(makeValidData({ equityCurveSampled: curve }));
    expect(doc.equityCurveSampled).toHaveLength(2);
    expect(doc.equityCurveSampled[0].timestamp).toBe(1700000000000);
    expect(doc.equityCurveSampled[0].equity).toBe(10000);
  });

  it('stores tradeSummary fields correctly', () => {
    const doc = new BacktestResultV2(makeValidData());
    expect(doc.tradeSummary.totalTrades).toBe(100);
    expect(doc.tradeSummary.winningTrades).toBe(55);
    expect(doc.tradeSummary.avgHoldTimeBars).toBe(12);
    expect(doc.tradeSummary.bestTrade.pnl).toBe(500);
    expect(doc.tradeSummary.bestTrade.pnlPercent).toBe(5);
    expect(doc.tradeSummary.worstTrade.pnl).toBe(-300);
    expect(doc.tradeSummary.worstTrade.pnlPercent).toBe(-3);
  });

  it('accepts optimization flags', () => {
    const doc = new BacktestResultV2(
      makeValidData({
        isOptimized: true,
        contributedToTemplate: true,
        optimizationGeneration: 3,
      })
    );
    expect(doc.isOptimized).toBe(true);
    expect(doc.contributedToTemplate).toBe(true);
    expect(doc.optimizationGeneration).toBe(3);
  });

  it('rejects missing userId', () => {
    const doc = new BacktestResultV2(makeValidData({ userId: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('userId');
  });

  it('rejects missing tradingStyle', () => {
    const doc = new BacktestResultV2(makeValidData({ tradingStyle: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('tradingStyle');
  });

  it('rejects missing symbol', () => {
    const doc = new BacktestResultV2(makeValidData({ symbol: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('symbol');
  });

  it('rejects missing interval', () => {
    const doc = new BacktestResultV2(makeValidData({ interval: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('interval');
  });

  it('rejects missing config', () => {
    const doc = new BacktestResultV2(makeValidData({ config: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('config');
  });

  it('rejects missing metrics', () => {
    const doc = new BacktestResultV2(makeValidData({ metrics: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('metrics');
  });

  it('rejects missing startTime', () => {
    const doc = new BacktestResultV2(makeValidData({ startTime: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('startTime');
  });

  it('rejects missing endTime', () => {
    const doc = new BacktestResultV2(makeValidData({ endTime: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('endTime');
  });

  it('rejects missing totalBars', () => {
    const doc = new BacktestResultV2(makeValidData({ totalBars: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('totalBars');
  });

  it('rejects missing warmupBars', () => {
    const doc = new BacktestResultV2(makeValidData({ warmupBars: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('warmupBars');
  });

  it('rejects missing tradeSummary.totalTrades', () => {
    const data = makeValidData();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (data as any).tradeSummary = { ...data.tradeSummary, totalTrades: undefined };
    const doc = new BacktestResultV2(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('tradeSummary.totalTrades');
  });

  it('rejects missing tradeSummary.winningTrades', () => {
    const data = makeValidData();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (data as any).tradeSummary = { ...data.tradeSummary, winningTrades: undefined };
    const doc = new BacktestResultV2(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('tradeSummary.winningTrades');
  });

  it('rejects missing tradeSummary.avgHoldTimeBars', () => {
    const data = makeValidData();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (data as any).tradeSummary = { ...data.tradeSummary, avgHoldTimeBars: undefined };
    const doc = new BacktestResultV2(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('tradeSummary.avgHoldTimeBars');
  });

  it('generates an _id automatically', () => {
    const doc = new BacktestResultV2(makeValidData());
    expect(doc._id).toBeDefined();
  });
});
