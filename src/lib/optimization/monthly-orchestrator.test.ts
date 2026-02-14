import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

// Mock dependencies
const mockCronRunUpdateOne = vi.fn();
const mockCronRunFindById = vi.fn();
const mockOptimizationJobCreate = vi.fn();
const mockOptimizationJobUpdateOne = vi.fn();
const mockSignalTemplateFindOne = vi.fn();
const mockGetCandleRange = vi.fn();
const mockGetCandles = vi.fn();
const mockBackfillCandles = vi.fn();
const mockRunWalkForward = vi.fn();
const mockCreateTemplateVersion = vi.fn();
const mockShouldAutoActivate = vi.fn();
const mockExecuteAutoActivation = vi.fn();

vi.mock('@/lib/models/cron-run', () => ({
  CronRun: {
    updateOne: (...args: unknown[]) => mockCronRunUpdateOne(...args),
    findById: (...args: unknown[]) => mockCronRunFindById(...args),
  },
}));

vi.mock('@/lib/models/optimization-job', () => ({
  OptimizationJob: {
    create: (...args: unknown[]) => mockOptimizationJobCreate(...args),
    updateOne: (...args: unknown[]) => mockOptimizationJobUpdateOne(...args),
  },
}));

vi.mock('@/lib/models/signal-template', () => ({
  SignalTemplate: {
    findOne: (...args: unknown[]) => mockSignalTemplateFindOne(...args),
  },
}));

vi.mock('@/lib/candle-ingestion', () => ({
  getCandleRange: (...args: unknown[]) => mockGetCandleRange(...args),
  getCandles: (...args: unknown[]) => mockGetCandles(...args),
  backfillCandles: (...args: unknown[]) => mockBackfillCandles(...args),
}));

vi.mock('./walk-forward', () => ({
  runWalkForward: (...args: unknown[]) => mockRunWalkForward(...args),
}));

vi.mock('./template-versioning', () => ({
  createTemplateVersion: (...args: unknown[]) => mockCreateTemplateVersion(...args),
}));

vi.mock('./auto-activation', () => ({
  shouldAutoActivate: (...args: unknown[]) => mockShouldAutoActivate(...args),
  executeAutoActivation: (...args: unknown[]) => mockExecuteAutoActivation(...args),
}));

vi.mock('./top-symbols', () => ({
  getIntervalForStyle: (style: string) => {
    const map: Record<string, string> = {
      scalping: '5m',
      day_trading: '1h',
      swing_trading: '4h',
      position_trading: '1d',
    };
    return map[style] || '1h';
  },
}));

vi.mock('@/types/optimization', () => ({
  DEFAULT_OPTIMIZATION_CONFIG: {
    minTrainingBars: 300,
    testWindowBars: 100,
    stepSizeBars: 300,
    candidatesPerWindow: 50,
    constraintPercent: 0.2,
  },
  DEFAULT_ROBUSTNESS: {},
}));

import { runMonthlyOptimization } from './monthly-orchestrator';

function makeCandles(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: Date.now() - (count - i) * 60_000,
    open: 40000 + i,
    high: 40100 + i,
    low: 39900 + i,
    close: 40050 + i,
    volume: 100,
  }));
}

function makeWalkForwardResult() {
  return {
    optimizedWeights: {
      trend: 0.30,
      momentum: 0.25,
      volume: 0.15,
      volatility: 0.10,
      futures: 0.10,
      sentiment: 0.10,
    },
    ensembleResults: [
      {
        _id: new mongoose.Types.ObjectId(),
        metrics: { sharpeRatio: 1.5, winRate: 0.55 },
      },
    ],
    windows: [{ trainStart: 0, trainEnd: 299, testStart: 300, testEnd: 399, bestWeights: {}, testSharpe: 1.5 }],
  };
}

describe('monthly-orchestrator', () => {
  const cronRunId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    vi.clearAllMocks();
    mockCronRunUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockOptimizationJobCreate.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
    });
    mockOptimizationJobUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockSignalTemplateFindOne.mockResolvedValue(null);
    mockBackfillCandles.mockResolvedValue(undefined);
    mockShouldAutoActivate.mockResolvedValue({
      shouldActivate: false,
      reason: 'Below threshold',
      metrics: { currentSharpe: 0, newSharpe: 1.0, improvement: 0 },
    });
  });

  it('processes all 4 trading styles and stores results', async () => {
    const candles = makeCandles(500);
    mockGetCandleRange.mockResolvedValue({ oldest: candles[0].timestamp, newest: candles[candles.length - 1].timestamp });
    mockGetCandles.mockResolvedValue(candles);
    mockRunWalkForward.mockResolvedValue(makeWalkForwardResult());
    mockCreateTemplateVersion.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      version: 1,
      tradingStyle: 'scalping',
    });
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId, status: 'completed' });

    const result = await runMonthlyOptimization({
      cronRunId,
      topSymbols: ['BTCUSDT', 'ETHUSDT'],
      months: 6,
      autoActivate: false,
    });

    expect(result.completedJobs).toBe(4);
    expect(result.failedJobs).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Walk-forward called 4 times (one per style)
    expect(mockRunWalkForward).toHaveBeenCalledTimes(4);
    // Template created for each style
    expect(mockCreateTemplateVersion).toHaveBeenCalledTimes(4);
  });

  it('records error and continues when one style has insufficient data', async () => {
    // First style returns insufficient candles, rest succeed
    let callCount = 0;
    mockGetCandleRange.mockResolvedValue({ oldest: 0, newest: Date.now() });
    mockGetCandles.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(makeCandles(100)); // Too few
      return Promise.resolve(makeCandles(500));
    });
    mockRunWalkForward.mockResolvedValue(makeWalkForwardResult());
    mockCreateTemplateVersion.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      version: 1,
    });
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId, status: 'completed' });

    const result = await runMonthlyOptimization({
      cronRunId,
      topSymbols: ['BTCUSDT'],
      months: 6,
      autoActivate: false,
    });

    expect(result.completedJobs).toBe(3);
    expect(result.failedJobs).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('scalping');
    expect(result.errors[0]).toContain('Insufficient data');
  });

  it('triggers backfill when range is stale (old newest)', async () => {
    const candles = makeCandles(500);
    // newest is very old, triggering backfill
    mockGetCandleRange.mockResolvedValue({
      oldest: candles[0].timestamp,
      newest: Date.now() - 120_000, // 2 minutes ago, stale
    });
    mockGetCandles.mockResolvedValue(candles);
    mockRunWalkForward.mockResolvedValue(makeWalkForwardResult());
    mockCreateTemplateVersion.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      version: 1,
    });
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId });

    await runMonthlyOptimization({
      cronRunId,
      topSymbols: ['BTCUSDT'],
      months: 6,
      autoActivate: false,
    });

    // Backfill called for every style since range is stale
    expect(mockBackfillCandles).toHaveBeenCalledTimes(4);
  });

  it('triggers backfill when range.newest is null (BUG-1 regression)', async () => {
    const candles = makeCandles(500);
    // newest is null -- this was the BUG-1 crash scenario
    mockGetCandleRange.mockResolvedValue({
      oldest: candles[0].timestamp,
      newest: null,
    });
    mockGetCandles.mockResolvedValue(candles);
    mockRunWalkForward.mockResolvedValue(makeWalkForwardResult());
    mockCreateTemplateVersion.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      version: 1,
    });
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId });

    // Should NOT crash (previously would crash on `range.newest!`)
    const result = await runMonthlyOptimization({
      cronRunId,
      topSymbols: ['BTCUSDT'],
      months: 6,
      autoActivate: false,
    });

    expect(result.completedJobs).toBe(4);
    expect(mockBackfillCandles).toHaveBeenCalledTimes(4);
  });

  it('records error when candle result is empty', async () => {
    mockGetCandleRange.mockResolvedValue({ oldest: 0, newest: Date.now() });
    mockGetCandles.mockResolvedValue([]); // Empty candles
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId });

    const result = await runMonthlyOptimization({
      cronRunId,
      topSymbols: ['BTCUSDT'],
      months: 6,
      autoActivate: false,
    });

    expect(result.completedJobs).toBe(0);
    expect(result.failedJobs).toBe(4);
    expect(result.errors).toHaveLength(4);
    for (const err of result.errors) {
      expect(err).toContain('Insufficient data');
    }
  });
});
