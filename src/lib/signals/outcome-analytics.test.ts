// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
});

async function importModules() {
  const { getLiveTierExpectancy } = await import('./outcome-analytics');
  const { SignalOutcome } = await import('@/lib/models/signal-outcome');
  return { getLiveTierExpectancy, SignalOutcome };
}

function makeResolvedOutcome(overrides: Record<string, unknown> = {}) {
  return {
    signalId: new mongoose.Types.ObjectId(),
    symbol: 'BTCUSDT',
    interval: '1h',
    tradingStyle: 'day_trading',
    tier: 'buy',
    score: 40,
    configVersion: 3,
    candleTimestamp: 1_700_000_000_000,
    horizonBars: 24,
    resolveAt: 1_700_000_000_000 + 25 * 60 * 60 * 1000,
    status: 'resolved',
    entryPrice: 100,
    resolvedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('getLiveTierExpectancy', () => {
  it('computes expectancy, win rate, and MFE/MAE per tier, flipping sell directionally', async () => {
    const { getLiveTierExpectancy, SignalOutcome } = await importModules();

    // Buy tier: directional return is +forwardReturnPercent
    await SignalOutcome.create(
      makeResolvedOutcome({
        symbol: 'BTCUSDT',
        tier: 'buy',
        forwardReturnPercent: 4,
        mfePercent: 6,
        maePercent: -2,
      })
    );
    await SignalOutcome.create(
      makeResolvedOutcome({
        symbol: 'BTCUSDT',
        tier: 'buy',
        forwardReturnPercent: -2,
        mfePercent: 3,
        maePercent: -5,
      })
    );

    // Sell tier: directional return is -forwardReturnPercent (price falling is a win)
    await SignalOutcome.create(
      makeResolvedOutcome({
        symbol: 'ETHUSDT',
        tier: 'sell',
        forwardReturnPercent: -3,
        mfePercent: 1,
        maePercent: -6,
      })
    );
    await SignalOutcome.create(
      makeResolvedOutcome({
        symbol: 'ETHUSDT',
        tier: 'sell',
        forwardReturnPercent: 2,
        mfePercent: 5,
        maePercent: -1,
      })
    );

    // Pending and unresolvable outcomes must be excluded
    await SignalOutcome.create(
      makeResolvedOutcome({
        symbol: 'BTCUSDT',
        tier: 'buy',
        status: 'pending',
        forwardReturnPercent: null,
        mfePercent: null,
        maePercent: null,
        entryPrice: null,
      })
    );
    await SignalOutcome.create(
      makeResolvedOutcome({
        symbol: 'BTCUSDT',
        tier: 'buy',
        status: 'unresolvable',
        forwardReturnPercent: null,
        mfePercent: null,
        maePercent: null,
        entryPrice: null,
      })
    );

    // A different trading style must be excluded
    await SignalOutcome.create(
      makeResolvedOutcome({
        symbol: 'BTCUSDT',
        tier: 'buy',
        tradingStyle: 'scalping',
        forwardReturnPercent: 100,
        mfePercent: 100,
        maePercent: 100,
      })
    );

    const results = await getLiveTierExpectancy({
      tradingStyle: 'day_trading',
      interval: '1h',
      costPercentRoundTrip: 0.1,
    });

    expect(results).toHaveLength(2);

    const buy = results.find((r) => r.tier === 'buy')!;
    expect(buy.count).toBe(2);
    expect(buy.expectancyPercent).toBeCloseTo(1 - 0.1, 6); // mean(4, -2) = 1
    expect(buy.winRate).toBeCloseTo(0.5, 6);
    expect(buy.avgMfePercent).toBeCloseTo(4.5, 6);
    expect(buy.avgMaePercent).toBeCloseTo(-3.5, 6);

    const sell = results.find((r) => r.tier === 'sell')!;
    expect(sell.count).toBe(2);
    // Directional: -(-3)=3, -(2)=-2 -> mean 0.5
    expect(sell.expectancyPercent).toBeCloseTo(0.5 - 0.1, 6);
    expect(sell.winRate).toBeCloseTo(0.5, 6);
    // MFE/MAE stay in the long perspective, never flipped
    expect(sell.avgMfePercent).toBeCloseTo(3, 6);
    expect(sell.avgMaePercent).toBeCloseTo(-3.5, 6);
  });

  it('returns tiers in SIGNAL_TIERS order regardless of insertion order', async () => {
    const { getLiveTierExpectancy, SignalOutcome } = await importModules();

    // Inserted out of SIGNAL_TIERS order (strong_buy, buy, neutral, sell, strong_sell)
    await SignalOutcome.create(makeResolvedOutcome({ tier: 'strong_sell', forwardReturnPercent: 1 }));
    await SignalOutcome.create(makeResolvedOutcome({ tier: 'sell', forwardReturnPercent: 1 }));
    await SignalOutcome.create(makeResolvedOutcome({ tier: 'strong_buy', forwardReturnPercent: 1 }));
    await SignalOutcome.create(makeResolvedOutcome({ tier: 'buy', forwardReturnPercent: 1 }));
    await SignalOutcome.create(makeResolvedOutcome({ tier: 'neutral', forwardReturnPercent: 1 }));

    const results = await getLiveTierExpectancy({ tradingStyle: 'day_trading', interval: '1h' });

    expect(results.map((r) => r.tier)).toEqual([
      'strong_buy',
      'buy',
      'neutral',
      'sell',
      'strong_sell',
    ]);
  });

  it('excludes a resolved document with a null forwardReturnPercent instead of coercing it to 0', async () => {
    const { getLiveTierExpectancy, SignalOutcome } = await importModules();

    await SignalOutcome.create(makeResolvedOutcome({ tier: 'buy', forwardReturnPercent: 10 }));
    // Data problem: resolved but somehow missing its return. Must not drag the average toward 0.
    await SignalOutcome.create(
      makeResolvedOutcome({ tier: 'buy', forwardReturnPercent: null, mfePercent: null, maePercent: null })
    );

    const results = await getLiveTierExpectancy({ tradingStyle: 'day_trading', interval: '1h' });

    expect(results).toHaveLength(1);
    expect(results[0].count).toBe(1);
    expect(results[0].expectancyPercent).toBeCloseTo(10, 6);
  });

  it('filters by symbol', async () => {
    const { getLiveTierExpectancy, SignalOutcome } = await importModules();

    await SignalOutcome.create(
      makeResolvedOutcome({ symbol: 'BTCUSDT', tier: 'buy', forwardReturnPercent: 5 })
    );
    await SignalOutcome.create(
      makeResolvedOutcome({ symbol: 'ETHUSDT', tier: 'buy', forwardReturnPercent: -5 })
    );

    const results = await getLiveTierExpectancy({
      tradingStyle: 'day_trading',
      interval: '1h',
      symbol: 'BTCUSDT',
    });

    expect(results).toHaveLength(1);
    expect(results[0].count).toBe(1);
    expect(results[0].expectancyPercent).toBeCloseTo(5, 6);
  });

  it('filters by interval, so a style scored at two intervals is never pooled', async () => {
    const { getLiveTierExpectancy, SignalOutcome } = await importModules();

    // Scalping writes outcomes at 1m and 5m with the same horizonBars (12),
    // which are 12 and 60 minutes of forward return: not the same measurement.
    await SignalOutcome.create(
      makeResolvedOutcome({ tradingStyle: 'scalping', interval: '1m', horizonBars: 12, tier: 'buy', forwardReturnPercent: 10 })
    );
    await SignalOutcome.create(
      makeResolvedOutcome({ tradingStyle: 'scalping', interval: '1m', horizonBars: 12, tier: 'buy', forwardReturnPercent: 6 })
    );
    await SignalOutcome.create(
      makeResolvedOutcome({ tradingStyle: 'scalping', interval: '5m', horizonBars: 12, tier: 'buy', forwardReturnPercent: -2 })
    );

    const fiveMinute = await getLiveTierExpectancy({ tradingStyle: 'scalping', interval: '5m' });
    expect(fiveMinute).toHaveLength(1);
    expect(fiveMinute[0].count).toBe(1);
    expect(fiveMinute[0].expectancyPercent).toBeCloseTo(-2, 6);

    const oneMinute = await getLiveTierExpectancy({ tradingStyle: 'scalping', interval: '1m' });
    expect(oneMinute).toHaveLength(1);
    expect(oneMinute[0].count).toBe(2);
    expect(oneMinute[0].expectancyPercent).toBeCloseTo(8, 6);
  });

  it('filters by since, based on resolvedAt', async () => {
    const { getLiveTierExpectancy, SignalOutcome } = await importModules();

    await SignalOutcome.create(
      makeResolvedOutcome({
        tier: 'buy',
        forwardReturnPercent: 1,
        resolvedAt: new Date('2026-01-01T00:00:00.000Z'),
      })
    );
    await SignalOutcome.create(
      makeResolvedOutcome({
        tier: 'buy',
        forwardReturnPercent: 9,
        resolvedAt: new Date('2026-09-01T00:00:00.000Z'),
      })
    );

    const results = await getLiveTierExpectancy({
      tradingStyle: 'day_trading',
      interval: '1h',
      since: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(results).toHaveLength(1);
    expect(results[0].count).toBe(1);
    expect(results[0].expectancyPercent).toBeCloseTo(9, 6);
  });

  it('defaults cost to 0 and returns an empty array when nothing matches', async () => {
    const { getLiveTierExpectancy, SignalOutcome } = await importModules();

    await SignalOutcome.create(makeResolvedOutcome({ tier: 'buy', forwardReturnPercent: 3 }));

    const withoutMatch = await getLiveTierExpectancy({ tradingStyle: 'scalping', interval: '5m' });
    expect(withoutMatch).toEqual([]);

    const withMatch = await getLiveTierExpectancy({ tradingStyle: 'day_trading', interval: '1h' });
    expect(withMatch[0].expectancyPercent).toBeCloseTo(3, 6);
  });

  it('treats neutral as informational using the raw forward return', async () => {
    const { getLiveTierExpectancy, SignalOutcome } = await importModules();

    await SignalOutcome.create(
      makeResolvedOutcome({ tier: 'neutral', forwardReturnPercent: -1.5 })
    );

    const results = await getLiveTierExpectancy({ tradingStyle: 'day_trading', interval: '1h' });
    expect(results).toHaveLength(1);
    expect(results[0].tier).toBe('neutral');
    expect(results[0].expectancyPercent).toBeCloseTo(-1.5, 6);
  });
});

describe('getLiveTierExpectancy source filter', () => {
  it('reads composite by default, including legacy rows without the field, and never llm rows', async () => {
    const { getLiveTierExpectancy, SignalOutcome } = await importModules();

    await SignalOutcome.create(
      makeResolvedOutcome({ tier: 'buy', forwardReturnPercent: 1.0 })
    ); // legacy: no source field
    await SignalOutcome.updateMany({}, { $unset: { source: 1 } });
    await SignalOutcome.create(
      makeResolvedOutcome({ tier: 'buy', forwardReturnPercent: 3.0, source: 'composite' })
    );
    await SignalOutcome.create(
      makeResolvedOutcome({ tier: 'buy', forwardReturnPercent: -9.0, source: 'llm' })
    );

    const composite = await getLiveTierExpectancy({ tradingStyle: 'day_trading', interval: '1h' });
    expect(composite).toEqual([
      expect.objectContaining({ tier: 'buy', count: 2, expectancyPercent: 2.0 }),
    ]);

    const llm = await getLiveTierExpectancy({ tradingStyle: 'day_trading', interval: '1h', source: 'llm' });
    expect(llm).toEqual([
      expect.objectContaining({ tier: 'buy', count: 1, expectancyPercent: -9.0 }),
    ]);
  });
});
