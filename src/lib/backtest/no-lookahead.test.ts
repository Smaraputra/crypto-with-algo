// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { computeWarmupBars, interpretIndicatorsAtBar } from '@/lib/indicators/interpret-at-bar';
import { computeSignalScore } from '@/lib/signals/scorer';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import type { OHLCV } from '@/types/market';
import type { SuperTrendPoint } from '@/lib/indicators/supertrend';

function generateCandles(count: number, seed = 987): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = seed;

  function nextRandom(): number {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 40) * 0.003;
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

function scoreAtBar(candles: OHLCV[], bar: number) {
  const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
  const superTrend = computeSuperTrend(candles);
  const stOffset = candles.length - superTrend.values.length;
  const stIdx = bar - stOffset;
  const superTrendAtBar: SuperTrendPoint | undefined =
    stIdx >= 0 && stIdx < superTrend.values.length ? superTrend.values[stIdx] : undefined;

  const suite = interpretIndicatorsAtBar(raw, bar, candles);
  return computeSignalScore(
    suite,
    null,
    null,
    DEFAULT_BACKTEST_CONFIG.weights,
    superTrendAtBar ? { values: superTrend.values, current: superTrendAtBar } : null
  );
}

// Removing bars AFTER bar N must not change anything the backtest computes AT
// bar N. Any future change that lets an interpreter or the scorer read past
// the current bar (lookahead bias) fails this test.
describe('no future-bar lookahead in per-bar scoring', () => {
  const candles = generateCandles(450);
  const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
  const warmup = computeWarmupBars(raw);

  // Truncated series must still satisfy computeMinCandles (longest period + 10),
  // so the earliest probe sits a little past warmup
  const probeBars = [warmup + 15, Math.floor(candles.length / 2), candles.length - 2];

  it.each(probeBars.map((bar) => ({ bar })))(
    'score at bar $bar is identical when future bars are removed',
    ({ bar }) => {
      const full = scoreAtBar(candles, bar);
      const truncated = scoreAtBar(candles.slice(0, bar + 1), bar);

      expect(truncated.score).toBeCloseTo(full.score, 10);
      expect(truncated.tier).toBe(full.tier);
      expect(truncated.components).toHaveLength(full.components.length);

      for (let i = 0; i < full.components.length; i++) {
        expect(truncated.components[i].category).toBe(full.components[i].category);
        expect(truncated.components[i].score).toBeCloseTo(full.components[i].score, 10);
        expect(truncated.components[i].weightedScore).toBeCloseTo(
          full.components[i].weightedScore,
          10
        );
      }
    }
  );

  it('snapshot series at bar N is identical when future snapshots are removed', async () => {
    const { buildSnapshotSeries } = await import('./snapshot-series');
    const probeBar = Math.floor(candles.length / 2);
    const snapshotDocs = candles.map((c, i) => ({
      timestamp: c.timestamp,
      data: { fearGreed: { index: (i * 7) % 100, label: 'Varies' } },
    }));

    const fullSeries = buildSnapshotSeries(candles, snapshotDocs, '1h');
    const truncatedDocs = snapshotDocs.filter((s) => s.timestamp <= candles[probeBar].timestamp);
    const truncatedSeries = buildSnapshotSeries(
      candles.slice(0, probeBar + 1),
      truncatedDocs,
      '1h'
    );

    for (let bar = 0; bar <= probeBar; bar++) {
      expect(truncatedSeries[bar]).toEqual(fullSeries[bar]);
    }
  });
});
