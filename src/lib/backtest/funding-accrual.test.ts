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
import type { Strategy } from './strategy';

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

// A position closed mid-loop (stop_loss, take_profit, time_stop, or signal)
// is null by the time the per-bar loop reaches its "survives to this bar's
// close" funding step, so its own exit bar's crossing was silently dropped.
// These use a custom bar-indexed Strategy (not the score-mocked approach
// above) for exact control over which bar triggers the exit.
describe('funding accrual on the exit bar itself', () => {
  beforeEach(() => {
    vi.mocked(computeSignalScore).mockReset();
  });

  /** Places one decision at `entryBar`, never again, and never exits by signal. */
  function oneShotStrategy(
    entryBar: number,
    buildDecision: (close: number) => NonNullable<ReturnType<Strategy['decideEntry']>>
  ): Strategy {
    let placed = false;
    return {
      name: 'test-one-shot',
      decideEntry(ctx) {
        if (placed || ctx.bar !== entryBar) return null;
        placed = true;
        return buildDecision(ctx.candles[ctx.bar].close);
      },
      decideExit() {
        return false;
      },
    };
  }

  it('a stop_loss exit charges the crossing that lands on its own bar', () => {
    const candles = generateFlatCandles(280);
    const warmup = computeWarmupBars(computeAllIndicators(candles, 'BTCUSDT', '1h'));
    mockScoresByBar(warmup, new Map());

    const entryBar = warmup + 1;
    // The first funding boundary strictly after entryBar: no bar between
    // entryBar+1 and exitBar-1 has a crossing, so exitBar's crossing is the
    // whole trade's funding, isolating whether the fix charges it at all.
    const exitBar = nextFundingBoundaryAfter(entryBar);
    candles[exitBar] = { ...candles[exitBar], low: 89 }; // forces a clean stop breach

    const strategy = oneShotStrategy(entryBar, (close) => ({
      side: 'long',
      orderType: 'market',
      stopPrice: close * 0.95, // above the forced low (89), below the flat 100
      targetPrice: null,
      timeStopBars: null,
    }));

    const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, fundingEnabled: true };
    const snapshots = buildSnapshotSeries(candles, makeSnapshots(candles), '1h', { symbol: 'BTCUSDT' });

    const result = runBacktest(
      candles,
      config,
      'BTCUSDT',
      '1h',
      undefined,
      snapshots,
      undefined,
      strategy
    );

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.entryBar).toBe(entryBar);
    expect(trade.exitBar).toBe(exitBar);
    expect(trade.exitReason).toBe('stop_loss');

    const notional = trade.quantity * 100; // price is flat at 100
    expect(trade.fundingCost).toBeCloseTo(1 * FUNDING_RATE * notional, 9);
  });

  it('a 1d trade closed by a time stop charges three crossings on its last (only held) bar', () => {
    // 1d bars align exactly with 8h funding boundaries, so every daily bar's
    // own window spans exactly 3 crossings (24h / 8h).
    const DAY_MS = 24 * 3600000;
    const candles: OHLCV[] = Array.from({ length: 260 }, (_, i) => ({
      timestamp: i * DAY_MS,
      open: 100,
      high: 100.05,
      low: 99.95,
      close: 100,
      volume: 1000,
    }));
    const warmup = computeWarmupBars(computeAllIndicators(candles, 'BTCUSDT', '1d'));
    mockScoresByBar(warmup, new Map());

    const entryBar = warmup + 1;
    const timeStopBars = 1; // closes exactly one bar later, isolating that bar's crossings
    const exitBar = entryBar + timeStopBars;

    const strategy = oneShotStrategy(entryBar, (close) => ({
      side: 'long',
      orderType: 'market',
      stopPrice: close * 0.5, // far away: must not trigger before the time stop
      targetPrice: null,
      timeStopBars,
    }));

    const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, fundingEnabled: true };
    const snapshots = buildSnapshotSeries(candles, makeSnapshots(candles), '1d', { symbol: 'BTCUSDT' });

    const result = runBacktest(
      candles,
      config,
      'BTCUSDT',
      '1d',
      undefined,
      snapshots,
      undefined,
      strategy
    );

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.exitBar).toBe(exitBar);
    expect(trade.exitReason).toBe('time_stop');

    // timeStopBars=1 means the exit bar is the only bar the position held,
    // so its 3 crossings are the whole trade's funding cost.
    const notional = trade.quantity * 100;
    expect(trade.fundingCost).toBeCloseTo(3 * FUNDING_RATE * notional, 9);
  });

  it('end_of_data funding is unchanged: the final held bar still accrues via the survives-to-close path', () => {
    const candles = generateFlatCandles(280);
    const warmup = computeWarmupBars(computeAllIndicators(candles, 'BTCUSDT', '1h'));
    mockScoresByBar(warmup, new Map());

    const entryBar = candles.length - 3; // near the end, so it never hits a stop/target/time-stop
    const strategy = oneShotStrategy(entryBar, (close) => ({
      side: 'long',
      orderType: 'market',
      stopPrice: close * 0.5,
      targetPrice: null,
      timeStopBars: null,
    }));

    const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, fundingEnabled: true };
    const snapshots = buildSnapshotSeries(candles, makeSnapshots(candles), '1h', { symbol: 'BTCUSDT' });

    const result = runBacktest(
      candles,
      config,
      'BTCUSDT',
      '1h',
      undefined,
      snapshots,
      undefined,
      strategy
    );

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.exitReason).toBe('end_of_data');

    const crossings = nextFundingBoundaryAfter(entryBar) <= trade.exitBar ? 1 : 0;
    const notional = trade.quantity * 100;
    expect(trade.fundingCost).toBeCloseTo(crossings * FUNDING_RATE * notional, 9);
  });
});
