// @vitest-environment node
//
// Engine-level funding accrual coverage. computeSignalScore is mocked so
// entry and exit bars are exact: candles are epoch-aligned hourly bars
// (timestamp = i * 3600000), so a funding boundary (00:00/08:00/16:00 UTC)
// falls exactly on bar i whenever (i + 1) is a multiple of 8. Price is flat
// throughout so notional is identical at every crossing, matching the
// formula in task-B3-brief.md verbatim: fundingCost == 2 * rate * notional
// for a trade that crosses exactly two funding events.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OHLCV } from '@/types/market';
import type { CompositeSignal } from '@/types/signal';

vi.mock('@/lib/signals/scorer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/signals/scorer')>();
  return { ...actual, computeSignalScore: vi.fn() };
});

import { computeSignalScore } from '@/lib/signals/scorer';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { computeWarmupBars } from '@/lib/indicators/interpret-at-bar';
import { runBacktest } from './engine';
import { buildSnapshotSeries } from './snapshot-series';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import type { BacktestConfig } from './types';

const FUNDING_RATE = 0.0001;

function generateFlatCandles(count: number): OHLCV[] {
  const candles: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    candles.push({
      timestamp: i * 3600000,
      open: 100,
      high: 100.05,
      low: 99.95,
      close: 100,
      volume: 1000,
    });
  }
  return candles;
}

/** Absolute bar index of the next funding boundary strictly after `bar`.
 * closeTime(i) = (i + 1) * 3600000 lands on a funding boundary exactly when
 * (i + 1) is a multiple of 8 (8h funding period, 1h candles). */
function nextFundingBoundaryAfter(bar: number): number {
  let i = bar + 1;
  while ((i + 1) % 8 !== 0) i++;
  return i;
}

function mockScoresByBar(warmup: number, scoreForBar: Map<number, number>) {
  let callIndex = 0;
  vi.mocked(computeSignalScore).mockImplementation(() => {
    const bar = warmup + callIndex;
    callIndex++;
    return {
      symbol: 'BTCUSDT',
      interval: '1h',
      score: scoreForBar.get(bar) ?? 0,
      tier: 'neutral',
      confidence: 0,
      components: [],
      timestamp: 0,
    } as CompositeSignal;
  });
}

function makeSnapshots(candles: OHLCV[]) {
  return candles.map((c) => ({
    timestamp: c.timestamp,
    data: { fundingRate: { rate: FUNDING_RATE, markPrice: c.close } },
  }));
}

describe('funding accrual', () => {
  beforeEach(() => {
    vi.mocked(computeSignalScore).mockReset();
  });

  it('a long trade held across exactly two funding crossings pays 2 * rate * notional', () => {
    const candles = generateFlatCandles(280);
    const warmup = computeWarmupBars(computeAllIndicators(candles, 'BTCUSDT', '1h'));

    const entryBar = warmup + 1;
    const boundary1 = nextFundingBoundaryAfter(entryBar);
    const boundary2 = nextFundingBoundaryAfter(boundary1);
    const exitBar = boundary2 + 2;

    mockScoresByBar(
      warmup,
      new Map([
        [entryBar, 60],
        [exitBar, -60],
      ])
    );

    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      fundingEnabled: true,
      stopLossPercent: 0.5,
      takeProfitPercent: 0.9,
    };
    const snapshots = buildSnapshotSeries(candles, makeSnapshots(candles), '1h', { symbol: 'BTCUSDT' });

    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, snapshots);

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.side).toBe('long');
    expect(trade.entryBar).toBe(entryBar);
    expect(trade.exitBar).toBe(exitBar);

    const notional = trade.quantity * 100; // price is flat at 100 throughout
    expect(trade.fundingCost).toBeCloseTo(2 * FUNDING_RATE * notional, 9);
  });

  it('the short mirror receives funding as a negative fundingCost', () => {
    const candles = generateFlatCandles(280);
    const warmup = computeWarmupBars(computeAllIndicators(candles, 'BTCUSDT', '1h'));

    const entryBar = warmup + 1;
    const boundary1 = nextFundingBoundaryAfter(entryBar);
    const boundary2 = nextFundingBoundaryAfter(boundary1);
    const exitBar = boundary2 + 2;

    mockScoresByBar(
      warmup,
      new Map([
        [entryBar, -60],
        [exitBar, 60],
      ])
    );

    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      fundingEnabled: true,
      allowShorts: true,
      stopLossPercent: 0.5,
      takeProfitPercent: 0.9,
    };
    const snapshots = buildSnapshotSeries(candles, makeSnapshots(candles), '1h', { symbol: 'BTCUSDT' });

    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, snapshots);

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.side).toBe('short');
    expect(trade.entryBar).toBe(entryBar);
    expect(trade.exitBar).toBe(exitBar);

    const notional = trade.quantity * 100;
    expect(trade.fundingCost).toBeCloseTo(-2 * FUNDING_RATE * notional, 9);
  });

  it('fundingEnabled absent gives fundingCost 0 even with funding data present', () => {
    const candles = generateFlatCandles(280);
    const warmup = computeWarmupBars(computeAllIndicators(candles, 'BTCUSDT', '1h'));
    const entryBar = warmup + 1;
    const exitBar = entryBar + 20;

    mockScoresByBar(
      warmup,
      new Map([
        [entryBar, 60],
        [exitBar, -60],
      ])
    );

    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      stopLossPercent: 0.5,
      takeProfitPercent: 0.9,
    };
    const snapshots = buildSnapshotSeries(candles, makeSnapshots(candles), '1h', { symbol: 'BTCUSDT' });

    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, snapshots);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].fundingCost).toBe(0);
  });

  it('fundingEnabled true but no snapshot series supplied gives fundingCost 0', () => {
    const candles = generateFlatCandles(280);
    const warmup = computeWarmupBars(computeAllIndicators(candles, 'BTCUSDT', '1h'));
    const entryBar = warmup + 1;
    const exitBar = entryBar + 20;

    mockScoresByBar(
      warmup,
      new Map([
        [entryBar, 60],
        [exitBar, -60],
      ])
    );

    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      fundingEnabled: true,
      stopLossPercent: 0.5,
      takeProfitPercent: 0.9,
    };

    const result = runBacktest(candles, config, 'BTCUSDT', '1h');

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].fundingCost).toBe(0);
  });
});
