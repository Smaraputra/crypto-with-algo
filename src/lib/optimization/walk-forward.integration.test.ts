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
      const candles = generateCandles(420);
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
        // Wiring is under test, not market luck: accept every candidate
        robustness: { minSharpe: -100, minWinRate: 0, maxDrawdown: 1, minTrades: 0 },
      });

      // Two anchored windows fit 420 bars with 260/60/60
      expect(result.windows).toHaveLength(2);
      expect(result.ensembleResults.length).toBeGreaterThan(0);
      expect(result.ensembleResults.length).toBeLessThanOrEqual(2);

      // Weights are normalized
      const weightSum = Object.values(result.optimizedWeights).reduce((s, w) => s + w, 0);
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
