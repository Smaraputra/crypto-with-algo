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
import * as candleIngestionModule from '@/lib/candle-ingestion';

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

  it('throws on an invalid document even when another document in the batch duplicates an existing signalId', async () => {
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

    await expect(
      createPendingOutcomes([
        {
          // Duplicates the pre-existing doc's signalId
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
          _id: new mongoose.Types.ObjectId(),
          symbol: 'ETHUSDT',
          interval: '1h',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tradingStyle: 'not_a_real_style' as any, // fails schema validation
          tier: 'sell',
          score: -45,
          configVersion: 3,
          candleTimestamp: 1_700_000_000_000,
        },
      ])
    ).rejects.toThrow();

    // Validation runs before insertMany, so nothing from this call, not
    // even the otherwise-valid duplicate, should have reached the database.
    const count = await SignalOutcome.countDocuments();
    expect(count).toBe(1);
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
    expect(result.failedGroups).toBe(0);

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

  it('marks an outcome unresolvable when a forward candle gap misaligns timestamps, even though the sliced window is still horizonBars long', async () => {
    const { resolveDueOutcomes, SignalOutcome, Candle } = await importModules();

    const T = 1_740_000_000_000;
    const horizonBars = 3;

    // Candle at T+2h is missing from storage, but T+4h exists, so the
    // position-sliced forward window ([T+1h, T+3h, T+4h]) still has exactly
    // horizonBars candles - the length check alone would not catch this.
    await Candle.insertMany([
      makeCandle('XRPUSDT', '1h', T, { close: 100 }),
      makeCandle('XRPUSDT', '1h', T + ONE_HOUR_MS, { close: 101 }),
      makeCandle('XRPUSDT', '1h', T + 3 * ONE_HOUR_MS, { close: 102 }),
      makeCandle('XRPUSDT', '1h', T + 4 * ONE_HOUR_MS, { close: 103 }),
    ]);

    const outcome = await SignalOutcome.create({
      signalId: new mongoose.Types.ObjectId(),
      symbol: 'XRPUSDT',
      interval: '1h',
      tradingStyle: 'day_trading',
      tier: 'buy',
      score: 20,
      configVersion: 3,
      candleTimestamp: T,
      horizonBars,
      resolveAt: T + (horizonBars + 1) * ONE_HOUR_MS,
    });

    const now = T + (horizonBars + 1) * ONE_HOUR_MS;
    const result = await resolveDueOutcomes(now);

    expect(result.resolved).toBe(0);
    expect(result.unresolvable).toBe(1);

    const updated = await SignalOutcome.findById(outcome._id);
    expect(updated!.status).toBe('unresolvable');
    expect(updated!.entryPrice).toBeNull();
  });

  it('returns zero counts when nothing is due', async () => {
    const { resolveDueOutcomes } = await importModules();
    const result = await resolveDueOutcomes(Date.now());
    expect(result).toEqual({ resolved: 0, unresolvable: 0, pending: 0, failedGroups: 0 });
  });

  it('fetches candles once per group even when it holds two outcomes at different candleTimestamps and horizons', async () => {
    const { resolveDueOutcomes, SignalOutcome, Candle } = await importModules();
    const getCandlesSpy = vi.spyOn(candleIngestionModule, 'getCandles');

    const T = 1_750_000_000_000;

    // outcome A: candleTimestamp T, horizonBars 2 -> needs T .. T+2h
    // outcome B: candleTimestamp T+1h, horizonBars 3 -> needs T+1h .. T+4h
    // Both share the ADAUSDT:1h group, so getCandles must be called once,
    // covering the full span up to the furthest resolveAt.
    await Candle.insertMany([
      makeCandle('ADAUSDT', '1h', T, { close: 10 }),
      makeCandle('ADAUSDT', '1h', T + ONE_HOUR_MS, { close: 11 }),
      makeCandle('ADAUSDT', '1h', T + 2 * ONE_HOUR_MS, { close: 12 }),
      makeCandle('ADAUSDT', '1h', T + 3 * ONE_HOUR_MS, { close: 13 }),
      makeCandle('ADAUSDT', '1h', T + 4 * ONE_HOUR_MS, { close: 14 }),
    ]);

    const outcomeA = await SignalOutcome.create({
      signalId: new mongoose.Types.ObjectId(),
      symbol: 'ADAUSDT',
      interval: '1h',
      tradingStyle: 'day_trading',
      tier: 'buy',
      score: 10,
      configVersion: 3,
      candleTimestamp: T,
      horizonBars: 2,
      resolveAt: T + 3 * ONE_HOUR_MS,
    });
    const outcomeB = await SignalOutcome.create({
      signalId: new mongoose.Types.ObjectId(),
      symbol: 'ADAUSDT',
      interval: '1h',
      tradingStyle: 'day_trading',
      tier: 'buy',
      score: 10,
      configVersion: 3,
      candleTimestamp: T + ONE_HOUR_MS,
      horizonBars: 3,
      resolveAt: T + 5 * ONE_HOUR_MS,
    });

    const now = T + 5 * ONE_HOUR_MS;
    const result = await resolveDueOutcomes(now);

    expect(result.resolved).toBe(2);
    expect(getCandlesSpy).toHaveBeenCalledTimes(1);

    const [symbolArg, intervalArg, startArg, endArg, limitArg] = getCandlesSpy.mock.calls[0];
    expect(symbolArg).toBe('ADAUSDT');
    expect(intervalArg).toBe('1h');
    expect(startArg).toBe(T); // min candleTimestamp across the group
    expect(endArg).toBe(T + 5 * ONE_HOUR_MS); // max resolveAt across the group
    // Enough bars between the earliest candleTimestamp and the furthest resolveAt
    expect(limitArg).toBeGreaterThanOrEqual(5);

    const updatedA = await SignalOutcome.findById(outcomeA._id);
    const updatedB = await SignalOutcome.findById(outcomeB._id);
    expect(updatedA!.status).toBe('resolved');
    expect(updatedB!.status).toBe('resolved');

    getCandlesSpy.mockRestore();
  });

  it('marks an outcome unresolvable when the entry candle itself is missing even though later candles exist', async () => {
    const { resolveDueOutcomes, SignalOutcome, Candle } = await importModules();

    const T = 1_760_000_000_000;

    // Entry candle at T was never stored; forward candles exist. This must
    // hit the entryIndex === undefined path, not the length/gap checks.
    await Candle.insertMany([
      makeCandle('DOTUSDT', '1h', T + ONE_HOUR_MS, { close: 20 }),
      makeCandle('DOTUSDT', '1h', T + 2 * ONE_HOUR_MS, { close: 21 }),
    ]);

    const outcome = await SignalOutcome.create({
      signalId: new mongoose.Types.ObjectId(),
      symbol: 'DOTUSDT',
      interval: '1h',
      tradingStyle: 'day_trading',
      tier: 'buy',
      score: 10,
      configVersion: 3,
      candleTimestamp: T,
      horizonBars: 2,
      resolveAt: T + 3 * ONE_HOUR_MS,
    });

    const now = T + 3 * ONE_HOUR_MS;
    const result = await resolveDueOutcomes(now);

    expect(result.resolved).toBe(0);
    expect(result.unresolvable).toBe(1);

    const updated = await SignalOutcome.findById(outcome._id);
    expect(updated!.status).toBe('unresolvable');
    expect(updated!.entryPrice).toBeNull();
  });

  it('resolves other groups and reports failedGroups when one group fails', async () => {
    const { resolveDueOutcomes, SignalOutcome, Candle } = await importModules();
    const actualGetCandles = candleIngestionModule.getCandles;
    const getCandlesSpy = vi
      .spyOn(candleIngestionModule, 'getCandles')
      .mockImplementation(async (symbol: string, interval: string, ...rest: unknown[]) => {
        if (symbol === 'FAILUSDT') {
          throw new Error('candle fetch failed');
        }
        return actualGetCandles(
          symbol,
          interval,
          ...(rest as [number | undefined, number | undefined, number | undefined])
        );
      });

    const T = 1_770_000_000_000;

    // Succeeding group
    await Candle.insertMany([
      makeCandle('BTCUSDT', '1h', T, { close: 100 }),
      makeCandle('BTCUSDT', '1h', T + ONE_HOUR_MS, { close: 105 }),
    ]);
    const okOutcome = await SignalOutcome.create({
      signalId: new mongoose.Types.ObjectId(),
      symbol: 'BTCUSDT',
      interval: '1h',
      tradingStyle: 'day_trading',
      tier: 'buy',
      score: 10,
      configVersion: 3,
      candleTimestamp: T,
      horizonBars: 1,
      resolveAt: T + 2 * ONE_HOUR_MS,
    });

    // Failing group: getCandles rejects for this symbol
    const failOutcome = await SignalOutcome.create({
      signalId: new mongoose.Types.ObjectId(),
      symbol: 'FAILUSDT',
      interval: '1h',
      tradingStyle: 'day_trading',
      tier: 'buy',
      score: 10,
      configVersion: 3,
      candleTimestamp: T,
      horizonBars: 1,
      resolveAt: T + 2 * ONE_HOUR_MS,
    });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const now = T + 2 * ONE_HOUR_MS;
    const result = await resolveDueOutcomes(now);

    expect(result.resolved).toBe(1);
    expect(result.failedGroups).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();

    const updatedOk = await SignalOutcome.findById(okOutcome._id);
    expect(updatedOk!.status).toBe('resolved');

    const updatedFail = await SignalOutcome.findById(failOutcome._id);
    expect(updatedFail!.status).toBe('pending'); // left untouched, retried next run

    getCandlesSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
