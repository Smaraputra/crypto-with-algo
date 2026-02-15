import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { OptimizationJob } from './optimization-job';

function makeValidData(overrides = {}) {
  return {
    tradingStyle: 'day_trading',
    symbol: 'BTCUSDT',
    interval: '1h',
    startTime: 1700000000000,
    endTime: 1700100000000,
    totalBars: 500,
    minTrainingBars: 300,
    testWindowBars: 100,
    stepSizeBars: 300,
    candidatesPerWindow: 50,
    constraintPercent: 0.2,
    ...overrides,
  };
}

describe('OptimizationJob model', () => {
  it('validates a document with all required fields', () => {
    const doc = new OptimizationJob(makeValidData());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default values for optional fields', () => {
    const doc = new OptimizationJob(makeValidData());
    expect(doc.status).toBe('pending');
    expect(doc.progress.currentWindow).toBe(0);
    expect(doc.progress.totalWindows).toBe(0);
    expect(doc.progress.candidatesTested).toBe(0);
    expect(doc.progress.validResults).toBe(0);
    expect(doc.optimizedWeights).toBeNull();
    expect(doc.ensembleResults).toEqual([]);
    expect(doc.templateVersion).toBeNull();
    expect(doc.error).toBeNull();
    expect(doc.startedAt).toBeNull();
    expect(doc.completedAt).toBeNull();
  });

  it('accepts all valid trading styles', () => {
    const styles = ['scalping', 'day_trading', 'swing_trading', 'position_trading'];
    for (const style of styles) {
      const doc = new OptimizationJob(makeValidData({ tradingStyle: style }));
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.tradingStyle).toBe(style);
    }
  });

  it('rejects invalid trading style', () => {
    const doc = new OptimizationJob(makeValidData({ tradingStyle: 'invalid_style' }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('tradingStyle');
  });

  it('accepts all valid status values', () => {
    const statuses = ['pending', 'running', 'completed', 'failed'];
    for (const status of statuses) {
      const doc = new OptimizationJob(makeValidData({ status }));
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.status).toBe(status);
    }
  });

  it('rejects invalid status', () => {
    const doc = new OptimizationJob(makeValidData({ status: 'invalid_status' }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('status');
  });

  it('accepts optimizedWeights', () => {
    const weights = {
      trend: 0.25,
      momentum: 0.30,
      volume: 0.20,
      volatility: 0.10,
      futures: 0.10,
      sentiment: 0.05,
    };
    const doc = new OptimizationJob(makeValidData({ optimizedWeights: weights }));
    expect(doc.optimizedWeights!.trend).toBe(0.25);
    expect(doc.optimizedWeights!.momentum).toBe(0.30);
    expect(doc.optimizedWeights!.volume).toBe(0.20);
    expect(doc.optimizedWeights!.volatility).toBe(0.10);
    expect(doc.optimizedWeights!.futures).toBe(0.10);
    expect(doc.optimizedWeights!.sentiment).toBe(0.05);
  });

  it('accepts ensembleResults as ObjectId array', () => {
    const ids = [
      new mongoose.Types.ObjectId(),
      new mongoose.Types.ObjectId(),
    ];
    const doc = new OptimizationJob(makeValidData({ ensembleResults: ids }));
    expect(doc.ensembleResults).toHaveLength(2);
    expect(doc.ensembleResults[0].toString()).toBe(ids[0].toString());
  });

  it('accepts progress values', () => {
    const doc = new OptimizationJob(
      makeValidData({
        progress: {
          currentWindow: 3,
          totalWindows: 5,
          candidatesTested: 150,
          validResults: 42,
        },
      })
    );
    expect(doc.progress.currentWindow).toBe(3);
    expect(doc.progress.totalWindows).toBe(5);
    expect(doc.progress.candidatesTested).toBe(150);
    expect(doc.progress.validResults).toBe(42);
  });

  it('accepts dates for startedAt and completedAt', () => {
    const now = new Date();
    const doc = new OptimizationJob(
      makeValidData({ startedAt: now, completedAt: now })
    );
    expect(doc.startedAt).toEqual(now);
    expect(doc.completedAt).toEqual(now);
  });

  it('accepts error string', () => {
    const doc = new OptimizationJob(
      makeValidData({ error: 'Insufficient data for walk-forward' })
    );
    expect(doc.error).toBe('Insufficient data for walk-forward');
  });

  it('accepts templateVersion', () => {
    const doc = new OptimizationJob(makeValidData({ templateVersion: 3 }));
    expect(doc.templateVersion).toBe(3);
  });

  it('rejects missing tradingStyle', () => {
    const doc = new OptimizationJob(makeValidData({ tradingStyle: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('tradingStyle');
  });

  it('rejects missing symbol', () => {
    const doc = new OptimizationJob(makeValidData({ symbol: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('symbol');
  });

  it('rejects missing interval', () => {
    const doc = new OptimizationJob(makeValidData({ interval: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('interval');
  });

  it('rejects missing startTime', () => {
    const doc = new OptimizationJob(makeValidData({ startTime: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('startTime');
  });

  it('rejects missing endTime', () => {
    const doc = new OptimizationJob(makeValidData({ endTime: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('endTime');
  });

  it('rejects missing totalBars', () => {
    const doc = new OptimizationJob(makeValidData({ totalBars: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('totalBars');
  });

  it('rejects missing minTrainingBars', () => {
    const doc = new OptimizationJob(makeValidData({ minTrainingBars: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('minTrainingBars');
  });

  it('rejects missing testWindowBars', () => {
    const doc = new OptimizationJob(makeValidData({ testWindowBars: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('testWindowBars');
  });

  it('rejects missing stepSizeBars', () => {
    const doc = new OptimizationJob(makeValidData({ stepSizeBars: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('stepSizeBars');
  });

  it('rejects missing candidatesPerWindow', () => {
    const doc = new OptimizationJob(makeValidData({ candidatesPerWindow: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('candidatesPerWindow');
  });

  it('rejects missing constraintPercent', () => {
    const doc = new OptimizationJob(makeValidData({ constraintPercent: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('constraintPercent');
  });

  it('stores numeric fields correctly', () => {
    const doc = new OptimizationJob(makeValidData());
    expect(doc.minTrainingBars).toBe(300);
    expect(doc.testWindowBars).toBe(100);
    expect(doc.stepSizeBars).toBe(300);
    expect(doc.candidatesPerWindow).toBe(50);
    expect(doc.constraintPercent).toBe(0.2);
  });

  it('generates an _id automatically', () => {
    const doc = new OptimizationJob(makeValidData());
    expect(doc._id).toBeDefined();
  });
});
