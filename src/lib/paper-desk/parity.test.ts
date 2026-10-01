// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { OHLCV } from '@/types/market';
import type { SignalTier } from '@/types/signal';
import type { MarketSession } from '@/lib/sessions';
import type { Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { BacktestConfig, BacktestTrade } from '@/lib/backtest/types';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtest/types';
import { runBacktest } from '@/lib/backtest/engine';
import { createScoreThresholdStrategy } from '@/lib/backtest/strategies/score-threshold';
import { studyCostConfig } from '@/lib/backtest/cost-model';
import { buildSnapshotSeries } from '@/lib/backtest/snapshot-series';
import { emptyLedger, stepLedger } from './step';
import type { BarDecision, DeskTrade } from './types';

/**
 * THE test that matters most.
 *
 * The paper desk exists to forward-test the rule the research measured. If it
 * books trades the engine would not, nothing it records can be compared with
 * any recorded number, and the forward test is worthless. So: record what the
 * engine's strategy was asked on every bar, replay exactly those decisions
 * through the desk's own step function, and require the trades to be identical.
 *
 * A divergence here means the desk is measuring something else, and the
 * divergence must be explained before the desk is believed.
 */

/** Deterministic random walk, the generator the engine's own parity test uses. */
function generateCandles(count: number, seed = 123): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = seed;
  const nextRandom = () => {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  };
  for (let i = 0; i < count; i++) {
    const drift = i < count / 2 ? 0.002 : -0.002;
    const noise = (nextRandom() - 0.5) * 0.5;
    price = price * (1 + drift + noise / 100);
    const high = price * (1 + nextRandom() * 0.005);
    const low = price * (1 - nextRandom() * 0.005);
    const open = price * (1 + (nextRandom() - 0.5) * 0.003);
    const volume = 1000 + nextRandom() * 5000;
    candles.push({
      timestamp: 1700000000000 + i * 3600000,
      open,
      high,
      low,
      close: price,
      volume,
      takerBuyVolume: volume * (0.3 + nextRandom() * 0.4),
    });
  }
  return candles;
}

interface Recorded {
  score: number;
  tier: SignalTier;
  session: MarketSession | null;
}

/**
 * Wraps the real strategy and records what it was asked on each bar.
 *
 * Both methods are wrapped because the engine calls `decideEntry` only when
 * flat and `decideExit` only when in a position (`bar-loop.ts:210-308`), so
 * only the pair covers every bar.
 */
function recordingStrategy(): { strategy: Strategy; seen: Map<number, Recorded>; calls: number[] } {
  const inner = createScoreThresholdStrategy();
  const seen = new Map<number, Recorded>();
  const calls: number[] = [];
  const note = (ctx: StrategyContext) => {
    calls.push(ctx.bar);
    seen.set(ctx.bar, { score: ctx.score, tier: ctx.tier, session: ctx.session });
  };
  return {
    seen,
    calls,
    strategy: {
      name: inner.name,
      decideEntry(ctx, config) {
        note(ctx);
        return inner.decideEntry(ctx, config);
      },
      decideExit(ctx, config) {
        note(ctx);
        return inner.decideExit(ctx, config);
      },
    },
  };
}

/** Replays recorded decisions through the desk, returning the trades it books. */
function replay(
  candles: OHLCV[],
  interval: string,
  config: BacktestConfig,
  warmupBars: number,
  seen: Map<number, Recorded>,
  fundingRates: (number | null)[]
): DeskTrade[] {
  let state = emptyLedger(config.startEquity);
  const closed: DeskTrade[] = [];
  for (let bar = warmupBars; bar < candles.length; bar++) {
    const rec = seen.get(bar);
    const decision: BarDecision = rec
      ? {
          scored: true,
          score: rec.score,
          tier: rec.tier,
          session: rec.session,
          // The engine fills at the signal bar's close; to compare like for
          // like the executable entry is allowed the very next bar.
          signalCreatedAt: candles[bar].timestamp + 1,
        }
      : { scored: false, score: 0, tier: 'neutral', session: null, signalCreatedAt: null };
    const outcome = stepLedger(state, {
      candles,
      bar,
      interval,
      decision,
      fundingRate: fundingRates[bar] ?? null,
      config,
    });
    state = outcome.state;
    closed.push(...outcome.closed);
  }
  return closed;
}

/** The engine force-closes an open position on the last bar; a live desk has no such bar. */
function comparable(trades: BacktestTrade[]): BacktestTrade[] {
  return trades.filter((t) => t.exitReason !== 'end_of_data');
}

const BASE: BacktestConfig = {
  ...DEFAULT_BACKTEST_CONFIG,
  positionSizing: { method: 'risk_based', riskPerTrade: 0.01 },
  ...studyCostConfig('1h'),
  startEquity: 10000,
};

/**
 * Thresholds well below the live 29 / 7.25, as `engine-parity.test.ts` also
 * does: on a synthetic series the live levels fire a handful of times, and a
 * parity test that compares two or three trades proves almost nothing. Each
 * case is chosen to produce dozens of trades across every exit reason the
 * rule can reach.
 */
const CASES: Array<{ name: string; config: BacktestConfig; minTrades: number }> = [
  {
    name: 'long only',
    minTrades: 30,
    config: {
      ...BASE,
      allowShorts: false,
      entryThreshold: 5,
      exitThreshold: 1,
      stopLossPercent: 0.006,
      takeProfitPercent: 0.012,
    },
  },
  {
    name: 'shorts with risk-based sizing (the research configuration)',
    minTrades: 60,
    config: {
      ...BASE,
      allowShorts: true,
      entryThreshold: 8,
      exitThreshold: 4,
      shortEntryThreshold: -8,
      shortExitThreshold: -4,
      stopLossPercent: 0.006,
      takeProfitPercent: 0.012,
    },
  },
  {
    name: 'tight stops and a wide exit band, so stops and targets drive every exit',
    minTrades: 100,
    config: {
      ...BASE,
      allowShorts: true,
      entryThreshold: 8,
      exitThreshold: -40,
      shortEntryThreshold: -8,
      shortExitThreshold: 40,
      stopLossPercent: 0.003,
      takeProfitPercent: 0.006,
    },
  },
];

const FUNDING_CASE: BacktestConfig = {
  ...BASE,
  allowShorts: true,
  entryThreshold: 8,
  exitThreshold: 4,
  shortEntryThreshold: -8,
  shortExitThreshold: -4,
  stopLossPercent: 0.006,
  takeProfitPercent: 0.012,
  fundingEnabled: true,
};

describe('paper desk parity with the backtest engine', () => {
  for (const { name, config, minTrades } of CASES) {
    it(`books the same trades as runBacktest: ${name}`, () => {
      const candles = generateCandles(800);
      const { strategy, seen, calls } = recordingStrategy();
      const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, undefined, strategy);

      // Every bar from warmup is asked exactly once, so the replay has a
      // decision for each and the recording cannot be silently incomplete.
      const expectedBars = candles.length - result.warmupBars;
      expect(seen.size).toBe(expectedBars);
      expect(calls).toHaveLength(expectedBars);
      expect(new Set(calls).size).toBe(expectedBars);

      const deskTrades = replay(candles, '1h', config, result.warmupBars, seen, candles.map(() => null));
      const engineTrades = comparable(result.trades);

      expect(engineTrades.length).toBeGreaterThanOrEqual(minTrades);
      expect(deskTrades.map((t) => t.engine)).toEqual(engineTrades);
    });
  }

  it('books the same trades with funding enabled on a sparse snapshot series', () => {
    const candles = generateCandles(800);
    const config = FUNDING_CASE;
    const snapshotDocs = candles
      .filter((_, i) => i % 4 === 0)
      .map((c) => ({
        timestamp: c.timestamp,
        data: {
          fundingRate: { rate: -0.002, markPrice: c.close },
          longShortRatio: { ratio: 2.5, longAccount: 0.71, shortAccount: 0.29 },
          fearGreed: { index: 20, label: 'Extreme Fear' },
        },
      }));
    // The desk reads funding through the engine's own pinning, so the two
    // cannot disagree about which rate applies to which bar.
    const series = buildSnapshotSeries(candles, snapshotDocs, '1h', { symbol: 'BTCUSDT' });

    const { strategy, seen } = recordingStrategy();
    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, series, undefined, strategy);
    const rates = series.map((s) => s?.futures?.fundingRate?.fundingRate ?? null);

    const deskTrades = replay(candles, '1h', config, result.warmupBars, seen, rates);
    const engineTrades = comparable(result.trades);

    expect(engineTrades.length).toBeGreaterThanOrEqual(60);
    expect(deskTrades.some((t) => t.engine.fundingCost !== 0)).toBe(true);
    expect(deskTrades.map((t) => t.engine)).toEqual(engineTrades);
  });

  it('covers the exit reasons the rule can produce, so parity is not vacuous', () => {
    const candles = generateCandles(800);
    const { config } = CASES[1];
    const { strategy, seen } = recordingStrategy();
    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, undefined, strategy);
    const desk = replay(candles, '1h', config, result.warmupBars, seen, candles.map(() => null));
    const reasons = new Set(desk.map((t) => t.engine.exitReason));
    expect(reasons).toEqual(new Set(['stop_loss', 'take_profit', 'signal']));
    expect(new Set(desk.map((t) => t.engine.side))).toEqual(new Set(['long', 'short']));
  });

  it('exercises the same-bar re-entry the engine allows after a stop or target', () => {
    const candles = generateCandles(800);
    const { config } = CASES[2];
    const { strategy, seen } = recordingStrategy();
    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, undefined, strategy);
    const desk = replay(candles, '1h', config, result.warmupBars, seen, candles.map(() => null));
    const engine = comparable(result.trades);

    // A trade entered on the bar a previous one exited is only possible via
    // the engine's same-bar re-entry rule, so this proves the replay walks
    // that path rather than merely agreeing on simpler ones.
    const sameBar = engine.filter((t, i) => i > 0 && t.entryBar === engine[i - 1].exitBar);
    expect(sameBar.length).toBeGreaterThan(0);
    expect(desk.map((t) => t.engine)).toEqual(engine);
  });

  it('never re-enters on the bar a signal exit closed a position', () => {
    const candles = generateCandles(800);
    const { config } = CASES[1];
    const { strategy, seen } = recordingStrategy();
    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, undefined, strategy);
    const desk = replay(candles, '1h', config, result.warmupBars, seen, candles.map(() => null));
    const trades = desk.map((t) => t.engine);
    const signalExits = trades.filter((t) => t.exitReason === 'signal');
    expect(signalExits.length).toBeGreaterThan(5);
    for (let i = 1; i < trades.length; i++) {
      if (trades[i - 1].exitReason === 'signal') {
        expect(trades[i].entryBar).toBeGreaterThan(trades[i - 1].exitBar);
      }
    }
  });
});
