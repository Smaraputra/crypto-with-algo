// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { aggTradeFrame, forceOrderFrame } from '@/__fixtures__/market-recorder';
import { JobHeartbeat } from '@/lib/models/job-heartbeat';
import { LiquidationEvent } from '@/lib/models/liquidation-event';
import { RecorderGap } from '@/lib/models/recorder-gap';
import { RecorderSymbolSet } from '@/lib/models/recorder-symbol-set';
import { TradeFlowBar } from '@/lib/models/trade-flow-bar';
import { MockWebSocket } from '@/test/mock-websocket';

import type { LiquidationRecord } from './messages';
import { MarketRecorder, webSocketFactory } from './recorder';
import { createMongoRecorderStore, ensureRecorderIndexes } from './store';
import { BUCKET_MS, type TradeFlowBarRecord } from './trade-flow';

// mongoose is connected to the in-memory server below; recordJobRun's own
// connectDB must not dial MONGODB_URI (see job-heartbeat.test.ts).
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await ensureRecorderIndexes();
  await JobHeartbeat.syncIndexes();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([
    LiquidationEvent.deleteMany({}),
    TradeFlowBar.deleteMany({}),
    RecorderGap.deleteMany({}),
    RecorderSymbolSet.deleteMany({}),
    JobHeartbeat.deleteMany({}),
  ]);
  MockWebSocket.resetMock();
});

const B0 = Date.UTC(2026, 9, 8, 12, 0, 0);

function liquidation(overrides: Partial<LiquidationRecord> = {}): LiquidationRecord {
  return {
    symbol: 'BTCUSDT',
    side: 'SELL',
    orderType: 'LIMIT',
    timeInForce: 'IOC',
    origQty: 0.5,
    price: 60_000,
    avgPrice: 60_010,
    status: 'FILLED',
    lastFilledQty: 0.5,
    filledAccumulatedQty: 0.5,
    tradeTime: B0 + 1_000,
    eventTime: B0 + 1_005,
    receivedAt: B0 + 1_100,
    pair: 'BTCUSDT',
    symbolType: 1,
    ...overrides,
  };
}

function bar(overrides: Partial<TradeFlowBarRecord> = {}): TradeFlowBarRecord {
  return {
    symbol: 'BTCUSDT',
    bucketStart: B0,
    trades: 10,
    aggTrades: 4,
    buyBase: 2,
    sellBase: 1,
    buyQuote: 200,
    sellQuote: 100,
    buyQuoteSmall: 200,
    sellQuoteSmall: 100,
    buyQuoteMedium: 0,
    sellQuoteMedium: 0,
    buyQuoteLarge: 0,
    sellQuoteLarge: 0,
    firstPrice: 100,
    lastPrice: 101,
    highPrice: 102,
    lowPrice: 99,
    firstAggId: 1_000,
    lastAggId: 1_003,
    complete: true,
    ...overrides,
  };
}

describe('ensureRecorderIndexes', () => {
  it('builds the dedupe and upsert keys as unique indexes', async () => {
    const liq = await LiquidationEvent.collection.indexes();
    const flow = await TradeFlowBar.collection.indexes();

    expect(liq.find((i) => i.unique)?.key).toEqual({ symbol: 1, tradeTime: 1, side: 1, filledAccumulatedQty: 1 });
    expect(flow.find((i) => i.unique)?.key).toEqual({ symbol: 1, bucketStart: 1 });
  });
});

describe('writeLiquidations', () => {
  it('stores an event once however often it is written', async () => {
    const store = createMongoRecorderStore();

    expect(await store.writeLiquidations([liquidation(), liquidation()])).toBe(1);
    expect(await store.writeLiquidations([liquidation()])).toBe(0);

    const docs = await LiquidationEvent.find({}).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ symbol: 'BTCUSDT', side: 'SELL', avgPrice: 60_010, pair: 'BTCUSDT', symbolType: 1 });
  });

  it('keeps events that differ in any key field', async () => {
    const store = createMongoRecorderStore();

    const stored = await store.writeLiquidations([
      liquidation(),
      liquidation({ filledAccumulatedQty: 0.7 }),
      liquidation({ side: 'BUY' }),
      liquidation({ tradeTime: B0 + 2_000 }),
      liquidation({ symbol: 'ETHUSDT' }),
    ]);

    expect(stored).toBe(5);
  });

  it('writes in chunks', async () => {
    const store = createMongoRecorderStore(2);
    const events = Array.from({ length: 5 }, (_, i) => liquidation({ tradeTime: B0 + i }));

    expect(await store.writeLiquidations(events)).toBe(5);
    expect(await LiquidationEvent.countDocuments({})).toBe(5);
  });
});

describe('writeTradeFlowBars', () => {
  async function stored() {
    return TradeFlowBar.findOne({ symbol: 'BTCUSDT', bucketStart: B0 }).lean<Record<string, unknown>>();
  }

  it('inserts a new bar with one segment', async () => {
    await createMongoRecorderStore().writeTradeFlowBars([bar()]);

    expect(await stored()).toMatchObject({ ...bar(), segments: 1 });
  });

  it('merges a later, disjoint part of the same bucket', async () => {
    const store = createMongoRecorderStore();
    await store.writeTradeFlowBars([bar()]);
    await store.writeTradeFlowBars([
      bar({
        trades: 3,
        aggTrades: 1,
        buyBase: 0,
        sellBase: 5,
        buyQuote: 0,
        sellQuote: 520_000,
        buyQuoteSmall: 0,
        sellQuoteSmall: 0,
        sellQuoteLarge: 520_000,
        firstPrice: 104,
        lastPrice: 104,
        highPrice: 104,
        lowPrice: 104,
        firstAggId: 1_010,
        lastAggId: 1_010,
        complete: false,
      }),
    ]);

    expect(await stored()).toMatchObject({
      trades: 13,
      aggTrades: 5,
      buyBase: 2,
      sellBase: 6,
      sellQuote: 520_100,
      sellQuoteSmall: 100,
      sellQuoteLarge: 520_000,
      firstPrice: 100,
      lastPrice: 104,
      highPrice: 104,
      lowPrice: 99,
      firstAggId: 1_000,
      lastAggId: 1_010,
      complete: false,
      segments: 2,
    });
  });

  it('takes the first price from an earlier part written second', async () => {
    const store = createMongoRecorderStore();
    await store.writeTradeFlowBars([bar()]);
    await store.writeTradeFlowBars([
      bar({ firstAggId: 900, lastAggId: 905, firstPrice: 95, lastPrice: 96, highPrice: 96, lowPrice: 95 }),
    ]);

    expect(await stored()).toMatchObject({
      firstAggId: 900,
      firstPrice: 95,
      lastAggId: 1_003,
      lastPrice: 101,
      lowPrice: 95,
      highPrice: 102,
      complete: true,
    });
  });

  it('replaces rather than adds on an overlapping retry, so a lost ack cannot double count', async () => {
    const store = createMongoRecorderStore();
    await store.writeTradeFlowBars([bar()]);
    await store.writeTradeFlowBars([bar()]);

    expect(await stored()).toMatchObject({ trades: 10, buyBase: 2, segments: 1 });
    expect(await TradeFlowBar.countDocuments({})).toBe(1);
  });
});

describe('gaps, symbol sets and the heartbeat', () => {
  it('closes every open gap row and reports how many there were', async () => {
    const store = createMongoRecorderStore();
    await store.writeGap({ start: B0, end: null, reason: 'shutdown (SIGTERM)' });
    await store.writeGap({ start: B0 - 10_000, end: B0 - 5_000, reason: 'closed 1006' });

    expect(await store.closeOpenGaps(B0 + 30_000)).toBe(1);
    expect(await store.closeOpenGaps(B0 + 40_000)).toBe(0);

    const open = await RecorderGap.findOne({ reason: 'shutdown (SIGTERM)' }).lean<{ end: number }>();
    expect(open?.end).toBe(B0 + 30_000);
  });

  it('reads the last healthy heartbeat back as epoch ms', async () => {
    const store = createMongoRecorderStore();
    expect(await store.lastHealthyAt()).toBeNull();

    const before = Date.now();
    await store.heartbeat({ ok: true, durationMs: 60_000, result: { connected: true }, error: null });
    await store.heartbeat({ ok: false, durationMs: 60_000, result: {}, error: 'not connected for 95 s' });

    const healthy = await store.lastHealthyAt();
    expect(healthy).toBeGreaterThanOrEqual(before);
    const row = await JobHeartbeat.findOne({ job: 'market-recorder' }).lean<{ lastStatus: string; lastError: string }>();
    expect(row).toMatchObject({ lastStatus: 'failure', lastError: 'not connected for 95 s' });
  });

  it('stores a symbol set in rank order', async () => {
    await createMongoRecorderStore().writeSymbolSet({
      refreshedAt: B0,
      topN: 2,
      eligibleCount: 523,
      symbols: [
        { symbol: 'BTCUSDT', quoteVolume: 13_836e6 },
        { symbol: 'ETHUSDT', quoteVolume: 10_301e6 },
      ],
      changed: true,
    });

    const row = await RecorderSymbolSet.findOne({}).lean<{ symbols: Array<{ symbol: string }> }>();
    expect(row?.symbols.map((s) => s.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
});

describe('the recorder end to end on the real write path', () => {
  it('records stream frames into Mongo and leaves the restart trail', async () => {
    const recorder = new MarketRecorder({
      socketFactory: webSocketFactory(MockWebSocket),
      store: createMongoRecorderStore(),
      fetchUniverse: async () => ({
        symbols: [
          { symbol: 'BTCUSDT', quoteVolume: 2e9 },
          { symbol: 'ETHUSDT', quoteVolume: 1e9 },
        ],
        eligibleCount: 500,
        topN: 2,
      }),
      wsBaseUrl: 'wss://test.local/market',
      log: () => {},
    });
    await recorder.start();
    const ws = MockWebSocket.lastInstance!;
    ws.simulateOpen();

    // Two closed buckets and one liquidation delivered twice.
    const B1 = B0 + BUCKET_MS;
    ws.simulateMessage(aggTradeFrame({ aggId: 1, price: 100, qty: 300, tradeTime: B0 + 1_000, buyerIsMaker: false }));
    ws.simulateMessage(aggTradeFrame({ aggId: 2, price: 101, qty: 50, tradeTime: B0 + 2_000, buyerIsMaker: true }));
    ws.simulateMessage(aggTradeFrame({ symbol: 'ETHUSDT', aggId: 7, price: 2_000, qty: 1, tradeTime: B1 + 1_000, buyerIsMaker: true }));
    ws.simulateMessage(forceOrderFrame({ symbol: 'SOLUSDT', tradeTime: B0 + 3_000 }));
    ws.simulateMessage(forceOrderFrame({ symbol: 'SOLUSDT', tradeTime: B0 + 3_000 }));

    await recorder.stop('SIGTERM');

    const bars = await TradeFlowBar.find({}).sort({ bucketStart: 1, symbol: 1 }).lean<Array<Record<string, unknown>>>();
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({
      symbol: 'BTCUSDT',
      bucketStart: B0,
      buyQuote: 30_000,
      buyQuoteMedium: 30_000,
      sellQuote: 5_050,
      sellQuoteSmall: 5_050,
      segments: 1,
    });
    expect(bars[1]).toMatchObject({ symbol: 'ETHUSDT', bucketStart: B1, sellBase: 1 });

    expect(await LiquidationEvent.countDocuments({ symbol: 'SOLUSDT' })).toBe(1);
    expect(await RecorderSymbolSet.countDocuments({})).toBe(1);

    const gaps = await RecorderGap.find({}).sort({ createdAt: 1 }).lean<Array<{ reason: string; end: number | null }>>();
    expect(gaps.map((g) => g.reason)).toEqual(['process-start', 'shutdown (SIGTERM)']);
    expect(gaps[0].end).not.toBeNull();
    expect(gaps[1].end).toBeNull();
  });
});
