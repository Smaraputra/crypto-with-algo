// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { OHLCV } from '@/types/market';
import type { StrategyContext } from '@/lib/backtest/strategy';
import { createScoreThresholdStrategy } from '@/lib/backtest/strategies/score-threshold';
import type { OpenPosition } from '@/lib/backtest/trade-utils';
import { TradePlanError, buildTradePlan, signalContext, type TradePlanInput } from './build';
import { CONTROL_EVIDENCE } from './evidence';
import { STOP_WINDOW_BARS, TRADE_PLAN_STRATEGY, stopsFor, tradePlanConfig } from './rule';

const HOUR = 3_600_000;

/** Flat 1h bars at `price` whose true range is 2% of the close, so the stop is 4% and the target 8%. */
function bars(count: number, price = 100): OHLCV[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: i * HOUR,
    open: price,
    high: price * 1.01,
    low: price * 0.99,
    close: price,
    volume: 1,
  }));
}

function input(overrides: Partial<TradePlanInput> & { score?: number; tier?: TradePlanInput['signal']['tier'] } = {}): TradePlanInput {
  const candles = overrides.candles ?? bars(1100);
  const { score = 35, tier = 'buy', ...rest } = overrides;
  return {
    symbol: 'SOLUSDT',
    style: 'day_trading',
    interval: '1h',
    signal: {
      score,
      tier,
      candleTimestamp: candles[candles.length - 1].timestamp,
      configVersion: 7,
      createdAt: new Date(candles[candles.length - 1].timestamp + HOUR + 30_000),
    },
    candles,
    fundingRate: 0.0001,
    ...rest,
  };
}

describe('buildTradePlan: the ticket is the rule', () => {
  it('matches decideEntry on the same context and config', () => {
    const plan = buildTradePlan(input());
    const candles = bars(1100);
    const bar = candles.length - 1;
    const config = tradePlanConfig('day_trading', '1h', stopsFor(candles), 1000);
    const decision = createScoreThresholdStrategy().decideEntry(
      signalContext(candles, bar, '1h', 35, 'buy', null),
      config
    );

    expect(decision).not.toBeNull();
    expect(plan.entry?.side).toBe(decision!.side);
    expect(plan.entry?.stopPrice).toBeCloseTo(decision!.stopPrice, 2);
    expect(plan.entry?.targetPrice).toBeCloseTo(decision!.targetPrice!, 2);
  });

  it('opens a long above the entry level with a 4% stop and an 8% target', () => {
    const plan = buildTradePlan(input());
    expect(plan.entry).toMatchObject({ side: 'long', referencePrice: 100, stopPrice: 96, targetPrice: 108 });
    expect(plan.entry?.stopPercent).toBeCloseTo(4, 10);
    expect(plan.entry?.targetPercent).toBeCloseTo(8, 10);
    expect(plan.entry?.medianTrueRangePercent).toBeCloseTo(2, 10);
  });

  it('opens a short below the negative entry level, stop above and target below', () => {
    const plan = buildTradePlan(input({ score: -35, tier: 'sell' }));
    expect(plan.entry).toMatchObject({ side: 'short', stopPrice: 104, targetPrice: 92 });
  });

  it('stays flat between the entry levels and reports which open trades would close', () => {
    const plan = buildTradePlan(input({ score: 20, tier: 'neutral' }));
    expect(plan.entry).toBeNull();
    // A long exits once the score falls to 7.25; a short once it rises to -7.25.
    expect(plan.holding).toEqual({ longExits: false, shortExits: true });

    const quiet = buildTradePlan(input({ score: 5, tier: 'neutral' }));
    expect(quiet.holding).toEqual({ longExits: true, shortExits: true });
  });

  it('enters at exactly 29 like the backtest, and notes that the live label disagrees', () => {
    const plan = buildTradePlan(input({ score: 29, tier: 'neutral' }));
    expect(plan.entry?.side).toBe('long');
    expect(plan.notes.some((n) => n.includes('29 or beyond') && n.includes('neutral'))).toBe(true);
  });

  it('adds no boundary note when the tier agrees', () => {
    expect(buildTradePlan(input()).notes).toEqual([]);
  });

  it('carries the rule parameters and the signal close time', () => {
    const plan = buildTradePlan(input());
    expect(plan.rule).toEqual({
      entryThreshold: 29,
      exitThreshold: 7.25,
      shortEntryThreshold: -29,
      shortExitThreshold: -7.25,
      stopWindowBars: STOP_WINDOW_BARS,
      riskPerTrade: 0.01,
      equity: 1000,
    });
    expect(plan.signal.closeTime).toBe(plan.signal.candleTimestamp + HOUR);
    expect(typeof plan.signal.createdAt).toBe('string');
  });
});

describe('buildTradePlan: causality', () => {
  it('ignores every bar after the scored one', () => {
    const history = bars(1100);
    const withFuture = [
      ...history,
      // A later crash bar that would widen the stop if it were read.
      { timestamp: 1100 * HOUR, open: 100, high: 100, low: 50, close: 60, volume: 1 },
    ];
    const base = buildTradePlan(input({ candles: history }));
    const future = buildTradePlan({
      ...input({ candles: withFuture }),
      signal: { ...base.signal, score: 35, tier: 'buy', createdAt: base.signal.createdAt },
    });
    expect(future.entry).toEqual(base.entry);
  });

  it('throws a TradePlanError when the scored bar is missing', () => {
    const candles = bars(10);
    const plan = input({ candles });
    expect(() =>
      buildTradePlan({ ...plan, signal: { ...plan.signal, candleTimestamp: 999 * HOUR } })
    ).toThrow(TradePlanError);
  });

  it('notes a stop measured over fewer bars than the window', () => {
    const plan = buildTradePlan(input({ candles: bars(200) }));
    expect(plan.notes[0]).toContain('199 true ranges');
  });
});

describe('buildTradePlan: size and venue', () => {
  it('sizes 1% risk against the model entry price and rounds down to the step', () => {
    const plan = buildTradePlan(input());
    const entry = plan.entry!;
    // Model entry is the close after 3 bps of 1h slippage; risk per unit is entry - stop.
    expect(entry.modelEntryPrice).toBeCloseTo(100.03, 10);
    const raw = (1000 * 0.01) / (100.03 - 96);
    expect(entry.quantity).toBe(Math.floor(raw * 100) / 100); // SOLUSDT step 0.01
    expect(entry.notional).toBeCloseTo(entry.quantity * 100, 10);
    expect(entry.leverage).toBeCloseTo(entry.notional / 1000, 10);
    expect(entry.riskAmount).toBeCloseTo(entry.quantity * (100.03 - 96), 10);
    expect(entry.placeable).toBe(true);
    expect(entry.notPlaceableReason).toBeNull();
    // SOLUSDT: tick 0.01, step 0.01.
    expect(entry.priceDecimals).toBe(2);
    expect(entry.quantityDecimals).toBe(2);
  });

  it('reports a ticket below the venue minimum as not placeable, with the reason', () => {
    // 10 USDT of equity risks 0.1 USDT: 0.0248 BTC at 100 is 2.4 USDT, below BTCUSDT's 50.
    const plan = buildTradePlan(input({ symbol: 'BTCUSDT', equity: 10 }));
    expect(plan.entry?.placeable).toBe(false);
    expect(plan.entry?.notPlaceableReason).toContain('below the BTCUSDT minimum of 50 USDT');
  });
});

describe('buildTradePlan: costs', () => {
  it('prices both exit paths with the study cost model at 1h', () => {
    const costs = buildTradePlan(input()).entry!.costs;
    expect(costs.entryFeePercent).toBeCloseTo(0.05, 10);
    expect(costs.entrySlippagePercent).toBeCloseTo(0.03, 10);
    expect(costs.stopExitPercent).toBeCloseTo(0.08, 10); // taker fee plus slippage
    expect(costs.targetExitPercent).toBeCloseTo(0.02, 10); // maker fee, no slippage
    expect(costs.roundTripStopPercent).toBeCloseTo(0.16, 10);
    expect(costs.roundTripTargetPercent).toBeCloseTo(0.1, 10);
    expect(costs.costShareOfRisk).toBeCloseTo(0.16 / 4, 10);
  });

  it('charges a long and credits a short the funding expected over the median hold', () => {
    // 1h median hold is 7 bars: 7/8 of a funding interval at 0.01%.
    const long = buildTradePlan(input()).entry!.costs;
    expect(long.expectedFundingCrossings).toBeCloseTo(7 / 8, 10);
    expect(long.fundingPercent).toBeCloseTo(0.0001 * (7 / 8) * 100, 12);
    const short = buildTradePlan(input({ score: -35, tier: 'sell' })).entry!.costs;
    expect(short.fundingPercent).toBeCloseTo(-0.0001 * (7 / 8) * 100, 12);
  });

  it('leaves funding unknown when the interval has no recorded hold or no rate', () => {
    const fourHour = buildTradePlan(
      input({ interval: '4h', style: 'swing_trading', candles: bars(1100).map((b, i) => ({ ...b, timestamp: i * 4 * HOUR })) })
    ).entry!.costs;
    expect(CONTROL_EVIDENCE['4h'].medianHoldBars).toBeNull();
    expect(fourHour.fundingPercent).toBeNull();
    expect(fourHour.fundingRate).toBe(0.0001);

    const noRate = buildTradePlan(input({ fundingRate: null })).entry!.costs;
    expect(noRate.fundingPercent).toBeNull();
  });

  it('attaches the recorded evidence for the interval', () => {
    expect(buildTradePlan(input()).evidence).toBe(CONTROL_EVIDENCE['1h']);
  });
});

describe('the rule reads only what the ticket supplies', () => {
  // The builder hands the strategy a context with no indicator suite,
  // snapshots or research columns. That is sound only while the strategy
  // never reads them; this trap throws on any other field.
  const allowed = new Set(['bar', 'candles', 'score', 'position']);
  function guarded(ctx: StrategyContext): StrategyContext {
    return new Proxy(ctx, {
      get(target, key, receiver) {
        if (typeof key === 'string' && !allowed.has(key)) {
          throw new Error(`score-threshold read ctx.${key}, which the trade plan does not supply`);
        }
        return Reflect.get(target, key, receiver);
      },
    });
  }

  it('decideEntry and decideExit touch only bar, candles, score and position', () => {
    const candles = bars(50);
    const config = tradePlanConfig('day_trading', '1h', stopsFor(candles));
    const position = { side: 'long' } as OpenPosition;
    for (const score of [-40, -29, 0, 29, 40]) {
      expect(() =>
        TRADE_PLAN_STRATEGY.decideEntry(guarded(signalContext(candles, 49, '1h', score, 'neutral', null)), config)
      ).not.toThrow();
      expect(() =>
        TRADE_PLAN_STRATEGY.decideExit(guarded(signalContext(candles, 49, '1h', score, 'neutral', position)), config)
      ).not.toThrow();
    }
  });
});
