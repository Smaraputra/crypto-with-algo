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

vi.mock('@/lib/models/signal-template', async (importOriginal) => ({
  // Keep the real constants (DEFAULT_TEMPLATE_THRESHOLDS); stub only queries.
  ...(await importOriginal<typeof import('@/lib/models/signal-template')>()),
  SignalTemplate: {
    findOne: (...args: unknown[]) => mockSignalTemplateFindOne(...args),
  },
}));

vi.mock('@/lib/candle-ingestion', () => ({
  getCandleRange: (...args: unknown[]) => mockGetCandleRange(...args),
  getCandles: (...args: unknown[]) => mockGetCandles(...args),
  backfillCandles: (...args: unknown[]) => mockBackfillCandles(...args),
}));

vi.mock('./walk-forward', async (importOriginal) => ({
  // deriveStepSize is a pure function; keep the real one so the orchestrator's
  // step derivation is exercised rather than stubbed.
  ...(await importOriginal<typeof import('./walk-forward')>()),
  runWalkForward: (...args: unknown[]) => mockRunWalkForward(...args),
}));

vi.mock('@/lib/historical-snapshots', () => ({
  getHistoricalSnapshots: vi.fn().mockResolvedValue([
    { timestamp: 1700000000000, data: { fearGreed: { index: 40, label: 'Fear' } } },
  ]),
}));

vi.mock('./template-versioning', () => ({
  createTemplateVersion: (...args: unknown[]) => mockCreateTemplateVersion(...args),
  markResultsAsContributors: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./auto-activation', () => ({
  shouldAutoActivate: (...args: unknown[]) => mockShouldAutoActivate(...args),
  executeAutoActivation: (...args: unknown[]) => mockExecuteAutoActivation(...args),
}));

const STYLE_INTERVALS: Record<string, string> = {
  scalping: '5m',
  day_trading: '1h',
  swing_trading: '4h',
  position_trading: '1d',
};
const STYLE_MONTHS: Record<string, number> = {
  scalping: 3,
  day_trading: 12,
  swing_trading: 24,
  position_trading: 48,
};

vi.mock('./top-symbols', () => ({
  getIntervalForStyle: (style: string) => STYLE_INTERVALS[style] || '1h',
  getMonthsForStyle: (style: string) => STYLE_MONTHS[style] ?? 12,
}));

import { runMonthlyOptimization } from './monthly-orchestrator';
import { deriveStepSize } from './walk-forward';
import { DEFAULT_OPTIMIZATION_CONFIG } from '@/types/optimization';
import { DEFAULT_TEMPLATE_THRESHOLDS } from '@/lib/models/signal-template';

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

/** Minimal BacktestMetrics stub; passesSaveGate only reads expectancyPercent. */
function makeOosMetrics(expectancyPercent: number) {
  return { expectancyPercent } as unknown as import('@/lib/backtest/types').BacktestMetrics;
}

/**
 * Two contributing windows with a positive mean out-of-sample expectancy, so
 * the save gate passes by default. Tests exercising the gate itself override
 * `windows` explicitly.
 */
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
    windows: [
      {
        trainStart: 0,
        trainEnd: 299,
        testStart: 300,
        testEnd: 399,
        bestWeights: {},
        testSharpe: 1.5,
        oosMetrics: makeOosMetrics(2.5),
        robustCandidates: 5,
      },
      {
        trainStart: 100,
        trainEnd: 399,
        testStart: 400,
        testEnd: 499,
        bestWeights: {},
        testSharpe: 1.2,
        oosMetrics: makeOosMetrics(1.8),
        robustCandidates: 4,
      },
    ],
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
    // Point-in-time snapshots are threaded through to walk-forward
    expect(mockRunWalkForward).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshots: [
          { timestamp: 1700000000000, data: { fearGreed: { index: 40, label: 'Fear' } } },
        ],
      })
    );
    // Confirmation-timeframe candles threaded through for intraday styles
    const scalpingCall = mockRunWalkForward.mock.calls.find(
      (call) => (call[0] as { tradingStyle: string }).tradingStyle === 'scalping'
    );
    expect((scalpingCall![0] as { htfInterval?: string }).htfInterval).toBe('1h');
    // position_trading (1d) has no confirmation timeframe
    const positionCall = mockRunWalkForward.mock.calls.find(
      (call) => (call[0] as { tradingStyle: string }).tradingStyle === 'position_trading'
    );
    expect((positionCall![0] as { htfInterval?: string }).htfInterval).toBeUndefined();
  });

  it('applies each style its own historical window when months is omitted', async () => {
    const candles = makeCandles(500);
    // Force a backfill so the requested window is observable in its arguments.
    mockGetCandleRange.mockResolvedValue({ oldest: null, newest: null });
    mockGetCandles.mockResolvedValue(candles);
    mockRunWalkForward.mockResolvedValue(makeWalkForwardResult());
    mockCreateTemplateVersion.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      version: 1,
      tradingStyle: 'scalping',
    });
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId, status: 'completed' });

    await runMonthlyOptimization({
      cronRunId,
      topSymbols: ['BTCUSDT'],
      autoActivate: false,
    });

    // Confirmation-timeframe backfills reuse the same intervals (scalping's HTF
    // is 1h, day_trading's primary), so assert on exact (interval, months)
    // pairs rather than keying by interval alone.
    const calls = mockBackfillCandles.mock.calls.map(
      (call) => [call[1] as string, call[2] as number] as const
    );
    expect(calls).toEqual(expect.arrayContaining([
      ['5m', 3],
      ['1h', 12],
      ['4h', 24],
      ['1d', 48],
    ]));
    // position_trading must get a window long enough to clear the 400-bar floor,
    // which the previous flat 6-month window never could.
    expect(48 * 30).toBeGreaterThan(400);
  });

  it('honours an explicit months override for every style', async () => {
    const candles = makeCandles(500);
    mockGetCandleRange.mockResolvedValue({ oldest: null, newest: null });
    mockGetCandles.mockResolvedValue(candles);
    mockRunWalkForward.mockResolvedValue(makeWalkForwardResult());
    mockCreateTemplateVersion.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      version: 1,
      tradingStyle: 'scalping',
    });
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId, status: 'completed' });

    await runMonthlyOptimization({
      cronRunId,
      topSymbols: ['BTCUSDT'],
      months: 9,
      autoActivate: false,
    });

    // Primary backfills use the override; confirmation-timeframe backfills add
    // the fixed 2-month warmup margin. Nothing should fall back to a per-style
    // default (3/12/24/48) once an override is supplied.
    const months = mockBackfillCandles.mock.calls.map((call) => call[2] as number);
    expect(months.length).toBeGreaterThan(0);
    for (const value of months) {
      expect([9, 11]).toContain(value);
    }
    expect(months).toContain(9);
  });

  it('derives a step size that bounds the window count for a 500-bar series', async () => {
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

    await runMonthlyOptimization({
      cronRunId,
      topSymbols: ['BTCUSDT'],
      autoActivate: false,
    });

    const expected = deriveStepSize(
      500,
      DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars,
      DEFAULT_OPTIMIZATION_CONFIG.testWindowBars,
      DEFAULT_OPTIMIZATION_CONFIG.targetWindows
    );
    // Not the old fixed 300, and small enough that 500 bars yield several windows.
    expect(expected).toBeLessThan(DEFAULT_OPTIMIZATION_CONFIG.stepSizeBars);
    for (const call of mockRunWalkForward.mock.calls) {
      expect((call[0] as { stepSizeBars: number }).stepSizeBars).toBe(expected);
    }
  });

  it('creates each template with the thresholds its weights were optimized against', async () => {
    const candles = makeCandles(500);
    mockGetCandleRange.mockResolvedValue({ oldest: candles[0].timestamp, newest: candles[candles.length - 1].timestamp });
    mockGetCandles.mockResolvedValue(candles);
    mockRunWalkForward.mockResolvedValue(makeWalkForwardResult());
    mockCreateTemplateVersion.mockResolvedValue({ _id: new mongoose.Types.ObjectId(), version: 1, tradingStyle: 'scalping' });
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId, status: 'completed' });

    await runMonthlyOptimization({ cronRunId, topSymbols: ['BTCUSDT'], autoActivate: false });

    expect(mockCreateTemplateVersion).toHaveBeenCalledTimes(4);
    for (const call of mockCreateTemplateVersion.mock.calls) {
      const style = call[0] as keyof typeof DEFAULT_TEMPLATE_THRESHOLDS;
      expect(call[2]).toEqual(DEFAULT_TEMPLATE_THRESHOLDS[style]);
    }
  });

  it('passes thresholds that satisfy the SignalTemplate schema', async () => {
    // Regression: with no active template the fallback was { bullish, bearish,
    // strong }, so the first styles to pass walk-forward in production failed
    // with "SignalTemplate validation failed". Validate against the real schema.
    const { SignalTemplate: RealSignalTemplate } = await vi.importActual<
      typeof import('@/lib/models/signal-template')
    >('@/lib/models/signal-template');
    const candles = makeCandles(500);
    mockGetCandleRange.mockResolvedValue({ oldest: candles[0].timestamp, newest: candles[candles.length - 1].timestamp });
    mockGetCandles.mockResolvedValue(candles);
    mockRunWalkForward.mockResolvedValue(makeWalkForwardResult());
    mockCreateTemplateVersion.mockResolvedValue({ _id: new mongoose.Types.ObjectId(), version: 1, tradingStyle: 'scalping' });
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId, status: 'completed' });
    mockSignalTemplateFindOne.mockResolvedValue(null);

    await runMonthlyOptimization({ cronRunId, topSymbols: ['BTCUSDT'], autoActivate: false });

    for (const call of mockCreateTemplateVersion.mock.calls) {
      const doc = new RealSignalTemplate({
        tradingStyle: call[0],
        version: 1,
        weights: call[1],
        thresholds: call[2],
        performanceMetrics: { avgSharpe: 1, avgWinRate: 0.5, totalBacktests: 1, lastOptimizedAt: new Date() },
        active: false,
      });
      const error = doc.validateSync();
      expect(error?.errors ? Object.keys(error.errors).filter((k) => k.startsWith('thresholds')) : []).toEqual([]);
    }
  });

  it('marks the optimization job failed when walk-forward throws', async () => {
    // Regression: the catch block only updated the CronRun, so production job
    // documents stayed 'running' after every style had failed.
    const candles = makeCandles(500);
    mockGetCandleRange.mockResolvedValue({ oldest: candles[0].timestamp, newest: candles[candles.length - 1].timestamp });
    mockGetCandles.mockResolvedValue(candles);
    mockRunWalkForward.mockRejectedValue(new Error('Cannot create ensemble from empty results'));
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId, status: 'failed' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runMonthlyOptimization({
      cronRunId,
      topSymbols: ['BTCUSDT'],
      autoActivate: false,
    });

    expect(result.failedJobs).toBe(4);
    const failedUpdates = mockOptimizationJobUpdateOne.mock.calls.filter(
      (call) => (call[1] as { $set?: { status?: string } }).$set?.status === 'failed'
    );
    expect(failedUpdates).toHaveLength(4);
    expect(failedUpdates[0][1]).toEqual({
      $set: {
        status: 'failed',
        error: 'Cannot create ensemble from empty results',
        completedAt: expect.any(Date),
      },
    });
  });

  it('does not touch job documents when a style fails before its job exists', async () => {
    mockGetCandleRange.mockResolvedValue({ oldest: 1, newest: Date.now() });
    mockGetCandles.mockResolvedValue(makeCandles(100)); // below the 400-bar floor
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId, status: 'failed' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runMonthlyOptimization({ cronRunId, topSymbols: ['BTCUSDT'], autoActivate: false });

    expect(mockOptimizationJobCreate).not.toHaveBeenCalled();
    expect(mockOptimizationJobUpdateOne).not.toHaveBeenCalled();
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

    // Backfill for every style's main interval (4) plus the HTF interval of
    // the three intraday styles (position_trading has no confirmation TF)
    expect(mockBackfillCandles).toHaveBeenCalledTimes(7);
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
    // 4 main-interval backfills plus 3 HTF backfills (no confirmation TF for 1d)
    expect(mockBackfillCandles).toHaveBeenCalledTimes(7);
  });

  it('skips template creation and records gateReason when the save gate refuses a save', async () => {
    const candles = makeCandles(500);
    mockGetCandleRange.mockResolvedValue({ oldest: candles[0].timestamp, newest: candles[candles.length - 1].timestamp });
    mockGetCandles.mockResolvedValue(candles);
    mockRunWalkForward.mockResolvedValue({
      ...makeWalkForwardResult(),
      // Single contributing window: below the save gate's 2-window minimum.
      windows: [
        {
          trainStart: 0,
          trainEnd: 299,
          testStart: 300,
          testEnd: 399,
          bestWeights: {},
          testSharpe: -1,
          oosMetrics: makeOosMetrics(-2),
          robustCandidates: 3,
        },
      ],
    });
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId, status: 'completed' });

    const result = await runMonthlyOptimization({
      cronRunId,
      topSymbols: ['BTCUSDT'],
      autoActivate: false,
    });

    // A refused save is a valid outcome, not an error: every style still
    // completes and no job is marked failed.
    expect(result.completedJobs).toBe(4);
    expect(result.failedJobs).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockCreateTemplateVersion).not.toHaveBeenCalled();
    expect(mockExecuteAutoActivation).not.toHaveBeenCalled();

    const jobUpdates = mockOptimizationJobUpdateOne.mock.calls.filter(
      (call) => (call[1] as { status?: string }).status === 'completed'
    );
    expect(jobUpdates).toHaveLength(4);
    for (const call of jobUpdates) {
      expect((call[1] as { templateVersion: number | null }).templateVersion).toBeNull();
    }

    const cronCompletions = mockCronRunUpdateOne.mock.calls.filter(
      (call) => (call[1] as { $set?: { 'jobs.$.status'?: string } }).$set?.['jobs.$.status'] === 'completed'
    );
    expect(cronCompletions).toHaveLength(4);
    for (const call of cronCompletions) {
      const set = (call[1] as { $set: Record<string, unknown> }).$set;
      expect(set['jobs.$.gateReason']).toContain('1 of 1');
    }
  });

  it('calls createTemplateVersion when the save gate passes', async () => {
    const candles = makeCandles(500);
    mockGetCandleRange.mockResolvedValue({ oldest: candles[0].timestamp, newest: candles[candles.length - 1].timestamp });
    mockGetCandles.mockResolvedValue(candles);
    mockRunWalkForward.mockResolvedValue(makeWalkForwardResult());
    mockCreateTemplateVersion.mockResolvedValue({ _id: new mongoose.Types.ObjectId(), version: 1, tradingStyle: 'scalping' });
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId, status: 'completed' });

    await runMonthlyOptimization({ cronRunId, topSymbols: ['BTCUSDT'], autoActivate: false });

    expect(mockCreateTemplateVersion).toHaveBeenCalledTimes(4);
    const cronCompletions = mockCronRunUpdateOne.mock.calls.filter(
      (call) => (call[1] as { $set?: { 'jobs.$.status'?: string } }).$set?.['jobs.$.status'] === 'completed'
    );
    for (const call of cronCompletions) {
      const set = (call[1] as { $set: Record<string, unknown> }).$set;
      expect(set['jobs.$.gateReason']).toBeNull();
    }
  });

  it('does not divide by zero when ensembleResults is empty', async () => {
    const candles = makeCandles(500);
    mockGetCandleRange.mockResolvedValue({ oldest: candles[0].timestamp, newest: candles[candles.length - 1].timestamp });
    mockGetCandles.mockResolvedValue(candles);
    mockRunWalkForward.mockResolvedValue({
      ...makeWalkForwardResult(),
      ensembleResults: [],
    });
    mockCreateTemplateVersion.mockResolvedValue({ _id: new mongoose.Types.ObjectId(), version: 1, tradingStyle: 'scalping' });
    mockCronRunFindById.mockResolvedValue({ _id: cronRunId, status: 'completed' });

    const result = await runMonthlyOptimization({ cronRunId, topSymbols: ['BTCUSDT'], autoActivate: false });

    expect(result.failedJobs).toBe(0);
    expect(mockCreateTemplateVersion).toHaveBeenCalledTimes(4);
    for (const call of mockCreateTemplateVersion.mock.calls) {
      const performance = call[3] as { avgSharpe: number; avgWinRate: number };
      expect(performance.avgSharpe).toBe(0);
      expect(performance.avgWinRate).toBe(0);
      expect(Number.isNaN(performance.avgSharpe)).toBe(false);
      expect(Number.isNaN(performance.avgWinRate)).toBe(false);
    }
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
