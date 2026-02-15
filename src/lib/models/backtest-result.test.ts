import { describe, it, expect } from 'vitest';
import { BacktestResult, MAX_BACKTEST_RESULTS_PER_USER } from './backtest-result';

function makeValidData(overrides = {}) {
  return {
    userId: 'user-1',
    symbol: 'BTCUSDT',
    interval: '1h',
    config: { strategy: 'momentum', param: 14 },
    metrics: { sharpeRatio: 1.5, winRate: 0.55 },
    totalBars: 500,
    warmupBars: 50,
    startTime: 1700000000000,
    endTime: 1700100000000,
    ...overrides,
  };
}

describe('BacktestResult model', () => {
  it('validates a document with all required fields', () => {
    const doc = new BacktestResult(makeValidData());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default values for optional fields', () => {
    const doc = new BacktestResult(makeValidData());
    expect(doc.strategyId).toBeNull();
    expect(doc.trades).toEqual([]);
    expect(doc.equityCurve).toEqual([]);
  });

  it('accepts custom strategyId', () => {
    const doc = new BacktestResult(makeValidData({ strategyId: 'strat-1' }));
    expect(doc.strategyId).toBe('strat-1');
  });

  it('accepts trades array', () => {
    const trades = [
      { type: 'buy', price: 50000, timestamp: 1700000000000 },
      { type: 'sell', price: 51000, timestamp: 1700001000000 },
    ];
    const doc = new BacktestResult(makeValidData({ trades }));
    expect(doc.trades).toEqual(trades);
  });

  it('accepts equityCurve array', () => {
    const equityCurve = [
      { timestamp: 1700000000000, equity: 10000 },
      { timestamp: 1700001000000, equity: 10200 },
    ];
    const doc = new BacktestResult(makeValidData({ equityCurve }));
    expect(doc.equityCurve).toEqual(equityCurve);
  });

  it('rejects missing userId', () => {
    const doc = new BacktestResult(makeValidData({ userId: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('userId');
  });

  it('rejects missing symbol', () => {
    const doc = new BacktestResult(makeValidData({ symbol: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('symbol');
  });

  it('rejects missing interval', () => {
    const doc = new BacktestResult(makeValidData({ interval: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('interval');
  });

  it('rejects missing config', () => {
    const doc = new BacktestResult(makeValidData({ config: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('config');
  });

  it('rejects missing metrics', () => {
    const doc = new BacktestResult(makeValidData({ metrics: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('metrics');
  });

  it('rejects missing totalBars', () => {
    const doc = new BacktestResult(makeValidData({ totalBars: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('totalBars');
  });

  it('rejects missing warmupBars', () => {
    const doc = new BacktestResult(makeValidData({ warmupBars: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('warmupBars');
  });

  it('rejects missing startTime', () => {
    const doc = new BacktestResult(makeValidData({ startTime: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('startTime');
  });

  it('rejects missing endTime', () => {
    const doc = new BacktestResult(makeValidData({ endTime: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('endTime');
  });

  it('stores numeric fields correctly', () => {
    const doc = new BacktestResult(makeValidData());
    expect(doc.totalBars).toBe(500);
    expect(doc.warmupBars).toBe(50);
    expect(doc.startTime).toBe(1700000000000);
    expect(doc.endTime).toBe(1700100000000);
  });

  it('exports MAX_BACKTEST_RESULTS_PER_USER constant', () => {
    expect(MAX_BACKTEST_RESULTS_PER_USER).toBe(50);
  });

  it('generates an _id automatically', () => {
    const doc = new BacktestResult(makeValidData());
    expect(doc._id).toBeDefined();
  });
});
