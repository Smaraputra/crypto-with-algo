// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// getCandles calls connectDB(); the memory server connection from beforeAll
// is already established, so this only needs to be a no-op.
vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

const ONE_HOUR_MS = 60 * 60 * 1000;

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
  const { createPendingOutcomes, resolveDueOutcomes } = await import('./outcome-resolver');
  const { SignalOutcome } = await import('@/lib/models/signal-outcome');
  const { Candle } = await import('@/lib/models/candle');
  return { createPendingOutcomes, resolveDueOutcomes, SignalOutcome, Candle };
}

function makeCandle(
  symbol: string,
  interval: string,
  timestamp: number,
  overrides: Record<string, number> = {}
) {
  return {
    symbol,
    interval,
    timestamp,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    ...overrides,
  };
}

describe('createPendingOutcomes', () => {
  it('creates one pending doc per signal with computed horizonBars and resolveAt', async () => {
    const { createPendingOutcomes, SignalOutcome } = await importModules();

    const signalIdA = new mongoose.Types.ObjectId();
    const signalIdB = new mongoose.Types.ObjectId();

    const inserted = await createPendingOutcomes([
      {
        _id: signalIdA,
        symbol: 'BTCUSDT',
        interval: '1h',
        tradingStyle: 'day_trading',
        tier: 'buy',
        score: 45,
        configVersion: 3,
        candleTimestamp: 1_700_000_000_000,
      },
      {
        _id: signalIdB,
        symbol: 'ETHUSDT',
        interval: '5m',
        tradingStyle: 'scalping',
        tier: 'sell',
        score: -40,
        configVersion: 3,
        candleTimestamp: 1_700_000_300_000,
      },
    ]);

    expect(inserted).toBe(2);

    const docs = await SignalOutcome.find().sort({ symbol: 1 }).lean();
    expect(docs).toHaveLength(2);

    const btc = docs.find((d) => d.symbol === 'BTCUSDT')!;
    expect(btc.signalId.toString()).toBe(signalIdA.toString());
    expect(btc.tradingStyle).toBe('day_trading');
    expect(btc.tier).toBe('buy');
    expect(btc.score).toBe(45);
    expect(btc.configVersion).toBe(3);
    expect(btc.candleTimestamp).toBe(1_700_000_000_000);
    expect(btc.horizonBars).toBe(24); // day_trading horizon
    expect(btc.resolveAt).toBe(1_700_000_000_000 + 25 * ONE_HOUR_MS);
    expect(btc.status).toBe('pending');

    const eth = docs.find((d) => d.symbol === 'ETHUSDT')!;
    expect(eth.horizonBars).toBe(12); // scalping horizon
    expect(eth.resolveAt).toBe(1_700_000_300_000 + 13 * 5 * 60 * 1000);
  });

  it('returns 0 for an empty signal list without querying the database', async () => {
    const { createPendingOutcomes } = await importModules();
    const inserted = await createPendingOutcomes([]);
    expect(inserted).toBe(0);
  });

  it('ignores a duplicate signalId so re-runs are idempotent', async () => {
    const { createPendingOutcomes, SignalOutcome } = await importModules();
    await SignalOutcome.syncIndexes();

    const existingSignalId = new mongoose.Types.ObjectId();
    await SignalOutcome.create({
      signalId: existingSignalId,
      symbol: 'BTCUSDT',
      interval: '1h',
      tradingStyle: 'day_trading',
      tier: 'buy',
      score: 45,
      configVersion: 3,
      candleTimestamp: 1_700_000_000_000,
      horizonBars: 24,
      resolveAt: 1_700_000_000_000 + 25 * ONE_HOUR_MS,
    });

    const newSignalId = new mongoose.Types.ObjectId();
    const inserted = await createPendingOutcomes([
      {
        _id: existingSignalId,
        symbol: 'BTCUSDT',
        interval: '1h',
        tradingStyle: 'day_trading',
        tier: 'buy',
        score: 45,
        configVersion: 3,
        candleTimestamp: 1_700_000_000_000,
      },
      {
        _id: newSignalId,
        symbol: 'ETHUSDT',
        interval: '1h',
        tradingStyle: 'day_trading',
        tier: 'sell',
        score: -45,
        configVersion: 3,
        candleTimestamp: 1_700_000_000_000,
      },
    ]);

    expect(inserted).toBe(1);
    const count = await SignalOutcome.countDocuments();
    expect(count).toBe(2);
  });

  it('propagates non-duplicate errors', async () => {
    const { createPendingOutcomes } = await importModules();

    await expect(
      createPendingOutcomes([
        {
          _id: new mongoose.Types.ObjectId(),
          symbol: 'BTCUSDT',
          interval: '1h',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tradingStyle: 'not_a_real_style' as any,
          tier: 'buy',
          score: 45,
          configVersion: 3,
          candleTimestamp: 1_700_000_000_000,
        },
      ])
    ).rejects.toThrow();
  });
});

describe('resolveDueOutcomes', () => {
  it('resolves a favorable and an adverse outcome, marks a missing-candle one unresolvable, and leaves not-yet-due ones pending', async () => {
    const { resolveDueOutcomes, SignalOutcome, Candle } = await importModules();

    const T0 = 1_700_000_000_000;
    const T1 = 1_710_000_000_000;
    const T2 = 1_720_000_000_000;
    const T3 = 1_730_000_000_000;

    // Favorable path: BTCUSDT, horizon 3 bars, entry 100 -> exit 105
    await Candle.insertMany([
      makeCandle('BTCUSDT', '1h', T0, { open: 99, high: 101, low: 98, close: 100 }),
      makeCandle('BTCUSDT', '1h', T0 + ONE_HOUR_MS, { open: 100, high: 112, low: 99, close: 110 }),
      makeCandle('BTCUSDT', '1h', T0 + 2 * ONE_HOUR_MS, { open: 110, high: 111, low: 88, close: 90 }),
      makeCandle('BTCUSDT', '1h', T0 + 3 * ONE_HOUR_MS, { open: 90, high: 106, low: 89, close: 105 }),
    ]);

    // Adverse path: ETHUSDT, horizon 2 bars, entry 200 -> exit 150
    await Candle.insertMany([
      makeCandle('ETHUSDT', '1h', T1, { open: 199, high: 201, low: 198, close: 200 }),
      makeCandle('ETHUSDT', '1h', T1 + ONE_HOUR_MS, { open: 200, high: 202, low: 170, close: 180 }),
      makeCandle('ETHUSDT', '1h', T1 + 2 * ONE_HOUR_MS, { open: 180, high: 185, low: 140, close: 150 }),
    ]);

    // Missing-candle path: SOLUSDT entry candle exists, forward candles do not
    await Candle.insertMany([
      makeCandle('SOLUSDT', '1h', T2, { open: 50, high: 51, low: 49, close: 50 }),
    ]);

    const btcOutcome = await SignalOutcome.create({
      signalId: new mongoose.Types.ObjectId(),
      symbol: 'BTCUSDT',
      interval: '1h',
      tradingStyle: 'day_trading',
      tier: 'buy',
      score: 45,
      configVersion: 3,
      candleTimestamp: T0,
      horizonBars: 3,
      resolveAt: T0 + 4 * ONE_HOUR_MS,
    });

    const ethOutcome = await SignalOutcome.create({
      signalId: new mongoose.Types.ObjectId(),
      symbol: 'ETHUSDT',
      interval: '1h',
      tradingStyle: 'day_trading',
      tier: 'sell',
      score: -45,
      configVersion: 3,
      candleTimestamp: T1,
      horizonBars: 2,
      resolveAt: T1 + 3 * ONE_HOUR_MS,
    });

    const solOutcome = await SignalOutcome.create({
      signalId: new mongoose.Types.ObjectId(),
      symbol: 'SOLUSDT',
      interval: '1h',
      tradingStyle: 'day_trading',
      tier: 'neutral',
      score: 0,
      configVersion: 3,
      candleTimestamp: T2,
      horizonBars: 2,
      resolveAt: T2 + 3 * ONE_HOUR_MS,
    });

    // Not-yet-due: resolveAt is far beyond "now"
    const notDueOutcome = await SignalOutcome.create({
      signalId: new mongoose.Types.ObjectId(),
      symbol: 'BNBUSDT',
      interval: '1h',
      tradingStyle: 'day_trading',
      tier: 'buy',
      score: 30,
      configVersion: 3,
      candleTimestamp: T3,
      horizonBars: 2,
      resolveAt: T3 + 100 * ONE_HOUR_MS,
    });

    const now = T2 + 3 * ONE_HOUR_MS;
    const result = await resolveDueOutcomes(now);

    expect(result.resolved).toBe(2);
    expect(result.unresolvable).toBe(1);
    expect(result.pending).toBe(1);

    const resolvedBtc = await SignalOutcome.findById(btcOutcome._id);
    expect(resolvedBtc!.status).toBe('resolved');
    expect(resolvedBtc!.entryPrice).toBe(100);
    expect(resolvedBtc!.forwardReturnPercent).toBeCloseTo(5, 6);
    expect(resolvedBtc!.mfePercent).toBeCloseTo(12, 6);
    expect(resolvedBtc!.maePercent).toBeCloseTo(-12, 6);
    expect(resolvedBtc!.resolvedAt).not.toBeNull();

    const resolvedEth = await SignalOutcome.findById(ethOutcome._id);
    expect(resolvedEth!.status).toBe('resolved');
    expect(resolvedEth!.entryPrice).toBe(200);
    expect(resolvedEth!.forwardReturnPercent).toBeCloseTo(-25, 6);
    expect(resolvedEth!.mfePercent).toBeCloseTo(1, 6);
    expect(resolvedEth!.maePercent).toBeCloseTo(-30, 6);

    const resolvedSol = await SignalOutcome.findById(solOutcome._id);
    expect(resolvedSol!.status).toBe('unresolvable');
    expect(resolvedSol!.entryPrice).toBeNull();

    const stillPending = await SignalOutcome.findById(notDueOutcome._id);
    expect(stillPending!.status).toBe('pending');
  });

  it('returns zero counts when nothing is due', async () => {
    const { resolveDueOutcomes } = await importModules();
    const result = await resolveDueOutcomes(Date.now());
    expect(result).toEqual({ resolved: 0, unresolvable: 0, pending: 0 });
  });
});
