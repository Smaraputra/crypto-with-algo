// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { runWalkForward } from './walk-forward';
import { OptimizationJob } from '@/lib/models/optimization-job';
import { BacktestResultV2 } from '@/lib/models/backtest-result-v2';
import type { OHLCV } from '@/types/market';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

function generateCandles(count: number, seed = 7): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = seed;

  function nextRandom(): number {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 30) * 0.004;
    const noise = (nextRandom() - 0.5) * 0.8;
    price = price * (1 + drift + noise / 100);
    const high = price * (1 + nextRandom() * 0.006);
    const low = price * (1 - nextRandom() * 0.006);
    const open = price * (1 + (nextRandom() - 0.5) * 0.004);
    const volume = 1000 + nextRandom() * 5000;

    candles.push({
      timestamp: 1700000000000 + i * 3600000,
      open,
      high,
      low,
      close: price,
      volume,
    });
  }

  return candles;
}

describe('runWalkForward integration', () => {
  it(
    'produces an out-of-sample ensemble end to end',
    async () => {
      // day_trading/1h's indicator warmup is 199 bars (SMA200 dominates), and
      // runWalkForward resolves that as the default purge gap. 420 bars no
      // longer fits even one window once that gap opens between training and
      // test, so the series is widened to 600 bars -- enough for exactly two
      // anchored windows: [0..259]->[459..518] and [0..319]->[519..578].
      const candles = generateCandles(600);
      const job = await OptimizationJob.create({
        tradingStyle: 'day_trading',
        symbol: 'TESTUSDT',
        interval: '1h',
        startTime: candles[0].timestamp,
        endTime: candles[candles.length - 1].timestamp,
        totalBars: candles.length,
        minTrainingBars: 260,
        testWindowBars: 60,
        stepSizeBars: 60,
        candidatesPerWindow: 8,
        constraintPercent: 0.2,
        status: 'running',
        progress: { currentWindow: 0, totalWindows: 0, candidatesTested: 0, validResults: 0 },
      });

      const snapshots = candles
        .filter((_, i) => i % 8 === 0)
        .map((c) => ({
          timestamp: c.timestamp,
          data: { fearGreed: { index: 35, label: 'Fear' } },
        }));

      // 4h confirmation candles spanning the range plus warmup margin
      const FOUR_H = 4 * 3600000;
      const htfCandles = generateCandles(460, 11).map((c, i) => ({
        ...c,
        timestamp: candles[0].timestamp - 290 * FOUR_H + i * FOUR_H,
      }));

      const result = await runWalkForward({
        candles,
        symbol: 'TESTUSDT',
        interval: '1h',
        tradingStyle: 'day_trading',
        minTrainingBars: 260,
        testWindowBars: 60,
        stepSizeBars: 60,
        candidatesPerWindow: 8,
        constraintPercent: 0.2,
        jobId: job._id,
        snapshots,
        htfCandles,
        htfInterval: '4h',
        // Wiring is under test, not market luck: accept every candidate
        robustness: { minSharpe: -100, maxDrawdown: 1, minTrades: 0, minExpectancyPercent: -Infinity },
      });

      // Two anchored windows fit 600 bars with 260/60/60 and the default
      // 199-bar purge gap: testStart = trainEnd + 1 + 199.
      expect(result.windows).toHaveLength(2);
      expect(result.windows[0]).toMatchObject({
        trainStart: 0,
        trainEnd: 259,
        testStart: 459,
        testEnd: 518,
      });
      expect(result.windows[1]).toMatchObject({
        trainStart: 0,
        trainEnd: 319,
        testStart: 519,
        testEnd: 578,
      });
      expect(result.ensembleResults.length).toBeGreaterThan(0);
      expect(result.ensembleResults.length).toBeLessThanOrEqual(2);

      // Weights are normalized. At least one window contributed (asserted
      // above), so an ensemble was built and optimizedWeights is non-null.
      expect(result.optimizedWeights).not.toBeNull();
      const weightSum = Object.values(result.optimizedWeights!).reduce((s, w) => s + w, 0);
      expect(weightSum).toBeCloseTo(1.0, 5);

      // Every ensemble contributor is an out-of-sample test doc
      for (const doc of result.ensembleResults) {
        expect(doc.parentResultId).not.toBeNull();
        expect(doc.optimizationGeneration).toBe(1);
      }

      // Windows reference their OOS docs, and those docs trade only the test
      // window: the run's first scored bar is exactly the window's testStart
      for (const window of result.windows) {
        expect(window.testResultId).toBeDefined();
        const doc = await BacktestResultV2.findById(window.testResultId);
        expect(doc).not.toBeNull();
        expect(doc!.startTime).toBe(candles[window.testStart].timestamp);
        expect(doc!.endTime).toBe(candles[window.testEnd].timestamp);
      }

      // The metrics that feed template creation and the auto-activation gate
      // come from the OOS docs themselves
      const avgSharpe =
        result.ensembleResults.reduce(
          (sum, r) => sum + (((r.metrics as Record<string, number>).sharpeRatio) ?? 0),
          0
        ) / result.ensembleResults.length;
      expect(Number.isFinite(avgSharpe)).toBe(true);

      // Job progress was tracked
      const updatedJob = await OptimizationJob.findById(job._id);
      expect(updatedJob!.progress.totalWindows).toBe(2);
      expect(updatedJob!.progress.currentWindow).toBe(2);
      expect(updatedJob!.progress.candidatesTested).toBe(16);
    },
    120_000
  );
});
