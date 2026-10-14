// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { PerpKline } from '@/lib/binance-futures';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { FundingSettlement } from '@/lib/models/funding-settlement';
import { RvSignal } from '@/lib/models/rv-signal';
import { RvBook, RV_BOOK_NAME } from '@/lib/models/rv-book';
import { RV_V1, rvComposite, rvFactors, rvInitialState } from './engine';
import { buildSyntheticUniverse } from './__fixtures__/rv-synthetic';
import { rvSignalBarTime, runRvSignal, storeRvSignal } from './generator';

const mocks = vi.hoisted(() => ({
  fetchPerpKlines: vi.fn(),
  syncFundingSettlements: vi.fn(),
}));
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/binance-futures', () => ({ fetchPerpKlines: mocks.fetchPerpKlines }));
vi.mock('@/lib/funding-settlement-sync', () => ({ syncFundingSettlements: mocks.syncFundingSettlements }));

const BAR = RV_V1.barMs;
const U = buildSyntheticUniverse();
const T0 = U.barTime;
/** One minute after the scored bar closed: the signal cron's own timing. */
const NOW = T0 + BAR + 60_000;
const OPTS = { retryDelayMs: 0 };

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await RvSignal.init();
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
  await RvSignal.init();
});

/** The fixture's closed 8h bars as Binance returns them, plus an absurd in-progress bar. */
function klines(symbol: string, scale = 1): PerpKline[] {
  const input = U.inputs.find((i) => i.symbol === symbol)!;
  const closed = input.bars.map((b) => ({
    openTime: b.openTime,
    closeTime: b.openTime + BAR - 1,
    open: b.close * scale,
    high: b.close * scale,
    low: b.close * scale,
    close: b.close * scale,
    quoteVolume: b.volume * b.close,
    volume: b.volume,
    trades: 100,
    takerBuyVolume: b.takerBuyVolume as number,
  }));
  const inProgress: PerpKline = {
    openTime: T0 + BAR,
    closeTime: T0 + 2 * BAR - 1,
    open: 1,
    high: 1e9,
    low: 1,
    close: 1e9,
    quoteVolume: 1,
    volume: 1,
    trades: 1,
    takerBuyVolume: 1,
  };
  return [...closed, inProgress];
}

async function seedSettlements(overrides: Record<string, number | null> = {}) {
  for (const input of U.inputs) {
    const fundingTime = input.symbol in overrides ? overrides[input.symbol] : T0 + BAR;
    if (fundingTime === null) continue;
    await FundingSettlement.create({
      symbol: input.symbol,
      fundingTime,
      rawTime: fundingTime + 1,
      rate: input.lastSettlement!.rate,
      intervalHours: 8,
      markPrice: input.lastSettlement!.markPrice,
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchPerpKlines.mockImplementation(async (symbol: string) => klines(symbol));
  mocks.syncFundingSettlements.mockImplementation(async (symbols: string[]) =>
    symbols.map((symbol) => ({ symbol, inserted: 0, updated: 0 }))
  );
});

describe('rvSignalBarTime', () => {
  it('is the open of the last closed 8h bar', () => {
    expect(rvSignalBarTime(T0 + BAR)).toBe(T0);
    expect(rvSignalBarTime(T0 + BAR + 60_000)).toBe(T0);
    expect(rvSignalBarTime(T0 + 2 * BAR - 1)).toBe(T0);
    expect(rvSignalBarTime(T0 + 2 * BAR)).toBe(T0 + BAR);
  });
});

describe('runRvSignal', () => {
  it('scores the last closed bar with the engine and stores rows, ranking and inputs', async () => {
    await seedSettlements();

    const res = await runRvSignal(NOW, OPTS);

    const expected = rvFactors(U.inputs, T0);
    const ranked = rvComposite(expected.rows, RV_V1.weights);
    expect(res).toEqual({
      success: true,
      barTime: T0,
      created: true,
      skipped: [],
      ranked,
      fetchErrors: [],
      syncErrors: [],
    });
    for (const symbol of SIGNAL_SYMBOLS) expect(mocks.fetchPerpKlines).toHaveBeenCalledWith(symbol, '8h', 45);
    expect(mocks.syncFundingSettlements).toHaveBeenCalledWith([...SIGNAL_SYMBOLS], NOW);

    const docs = await RvSignal.find().lean();
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc).toMatchObject({ version: 'rv-v1', barTime: T0, barCloseTime: T0 + BAR, skipped: [] });
    expect(doc.rows).toEqual(expected.rows);
    expect(doc.ranked).toEqual(ranked);
    expect(doc.createdAt).toBeInstanceOf(Date);
    for (const input of U.inputs) {
      expect(doc.inputs.lastBarOpenTime[input.symbol]).toBe(T0);
      expect(doc.inputs.settlement[input.symbol]).toEqual({ fundingTime: T0 + BAR, rate: input.lastSettlement!.rate });
    }
  });

  it('excludes the in-progress kline (its absurd close never reaches the score)', async () => {
    await seedSettlements();
    const res = await runRvSignal(NOW, OPTS);
    expect(res.success).toBe(true);
    const doc = await RvSignal.findOne().lean();
    expect(doc!.rows.every((r) => Math.abs(r.mom) < 1)).toBe(true);
    expect(doc!.skipped).toEqual([]);
  });

  it('skips a symbol whose last closed bar is not barTime, with a reason', async () => {
    await seedSettlements();
    mocks.fetchPerpKlines.mockImplementation(async (symbol: string) =>
      symbol === 'DOTUSDT' ? klines(symbol).slice(0, -2) : klines(symbol)
    );

    const res = await runRvSignal(NOW, OPTS);

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.skipped).toEqual([{ symbol: 'DOTUSDT', reason: 'bars_incomplete' }]);
    expect(res.ranked.map((r) => r.symbol)).not.toContain('DOTUSDT');
    const doc = await RvSignal.findOne().lean();
    expect(doc!.inputs.lastBarOpenTime.DOTUSDT).toBe(T0 - BAR);
  });

  it('retries a failed kline fetch once and scores the symbol when the retry succeeds', async () => {
    await seedSettlements();
    mocks.fetchPerpKlines.mockImplementation(async (symbol: string) => klines(symbol));
    mocks.fetchPerpKlines.mockImplementationOnce(async () => {
      throw new Error('HTTP 503');
    });

    const res = await runRvSignal(NOW, OPTS);

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.skipped).toEqual([]);
    expect(res.fetchErrors).toEqual([]);
    expect(mocks.fetchPerpKlines).toHaveBeenCalledTimes(SIGNAL_SYMBOLS.length + 1);
  });

  it('gives up after one retry: the symbol has no bars, is skipped with a reason and the error is reported', async () => {
    await seedSettlements();
    mocks.fetchPerpKlines.mockImplementation(async (symbol: string) => {
      if (symbol === 'XRPUSDT') throw new Error('HTTP 503');
      return klines(symbol);
    });

    const res = await runRvSignal(NOW, OPTS);

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(mocks.fetchPerpKlines.mock.calls.filter(([s]) => s === 'XRPUSDT')).toHaveLength(2);
    expect(res.skipped).toEqual([{ symbol: 'XRPUSDT', reason: 'bars_incomplete' }]);
    expect(res.fetchErrors).toEqual([{ symbol: 'XRPUSDT', error: 'HTTP 503' }]);
    const doc = await RvSignal.findOne().lean();
    expect(doc!.inputs.lastBarOpenTime.XRPUSDT).toBeNull();
  });

  it('D11: carry comes from the stored settlement at the bar close, stale or missing is skipped, never 0', async () => {
    // ADA's newest settlement is one bar too old, LINK has none, and BNB has a
    // newer one after the bar close that must be ignored.
    await seedSettlements({ ADAUSDT: T0, LINKUSDT: null });
    const bnb = U.inputs.find((i) => i.symbol === 'BNBUSDT')!;
    await FundingSettlement.create({
      symbol: 'BNBUSDT',
      fundingTime: T0 + 2 * BAR,
      rawTime: T0 + 2 * BAR + 1,
      rate: 0.05,
      intervalHours: 8,
    });

    const res = await runRvSignal(NOW, OPTS);

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.skipped).toEqual([
      { symbol: 'ADAUSDT', reason: 'carry_stale' },
      { symbol: 'LINKUSDT', reason: 'carry_missing' },
    ]);
    const doc = await RvSignal.findOne().lean();
    expect(doc!.inputs.settlement.ADAUSDT).toEqual({ fundingTime: T0, rate: U.inputs.find((i) => i.symbol === 'ADAUSDT')!.lastSettlement!.rate });
    expect(doc!.inputs.settlement.LINKUSDT).toBeNull();
    expect(doc!.inputs.settlement.BNBUSDT).toEqual({ fundingTime: T0 + BAR, rate: bnb.lastSettlement!.rate });
    expect(doc!.rows.find((r) => r.symbol === 'BNBUSDT')!.carry).toBe(-bnb.lastSettlement!.rate);
  });

  it('syncs settlements before reading them and reports per-symbol sync errors', async () => {
    await seedSettlements({ ETHUSDT: null });
    mocks.syncFundingSettlements.mockImplementation(async (symbols: string[]) => {
      // The sync is what brings ETH's settlement in, so it must run before the read
      const eth = U.inputs.find((i) => i.symbol === 'ETHUSDT')!;
      await FundingSettlement.create({
        symbol: 'ETHUSDT',
        fundingTime: T0 + BAR,
        rawTime: T0 + BAR + 2,
        rate: eth.lastSettlement!.rate,
        source: 'rest',
      });
      return symbols.map((symbol) =>
        symbol === 'DOGEUSDT'
          ? { symbol, inserted: 0, updated: 0, error: 'HTTP 418' }
          : { symbol, inserted: 0, updated: 0 }
      );
    });

    const res = await runRvSignal(NOW, OPTS);

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.skipped).toEqual([]);
    expect(res.syncErrors).toEqual([{ symbol: 'DOGEUSDT', error: 'HTTP 418' }]);
  });

  it('returns the data error code and stores nothing when BTC cannot be scored', async () => {
    await seedSettlements();
    mocks.fetchPerpKlines.mockImplementation(async (symbol: string) => {
      if (symbol === 'BTCUSDT') throw new Error('HTTP 503');
      return klines(symbol);
    });

    const res = await runRvSignal(NOW, OPTS);

    expect(res).toMatchObject({ success: false, barTime: T0, code: 'btc_missing' });
    expect(res.success === false && res.error).toMatch(/^btc_missing/);
    expect(await RvSignal.countDocuments()).toBe(0);
  });

  it('returns universe_too_small when fewer than five symbols survive', async () => {
    await seedSettlements();
    mocks.fetchPerpKlines.mockImplementation(async (symbol: string) => {
      if (['ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT'].includes(symbol)) throw new Error('HTTP 503');
      return klines(symbol);
    });
    const res = await runRvSignal(NOW, OPTS);
    expect(res).toMatchObject({ success: false, code: 'universe_too_small' });
    expect(await RvSignal.countDocuments()).toBe(0);
  });

  it('D07: refuses to store a signal that skips a held symbol, so the retry can score it', async () => {
    await seedSettlements();
    const taker = rvInitialState();
    taker.positions.SOLUSDT = { qty: 2, avgEntry: 100, lastMark: 100 };
    await RvBook.create({
      bookName: RV_BOOK_NAME,
      version: 'rv-v1',
      startedAt: new Date(T0),
      tracks: { taker, maker: rvInitialState() },
    });
    mocks.fetchPerpKlines.mockImplementation(async (symbol: string) => {
      if (symbol === 'SOLUSDT') throw new Error('HTTP 503');
      return klines(symbol);
    });

    const first = await runRvSignal(NOW, OPTS);

    expect(first).toMatchObject({ success: false, code: 'held_symbol_skipped' });
    expect(first.success === false && first.error).toMatch(/SOLUSDT \(bars_incomplete\)/);
    expect(await RvSignal.countDocuments()).toBe(0);

    // The retry at minute 31 finds the venue back and stores the signal
    mocks.fetchPerpKlines.mockImplementation(async (symbol: string) => klines(symbol));
    const retry = await runRvSignal(NOW + 30 * 60_000, OPTS);
    expect(retry).toMatchObject({ success: true, created: true, skipped: [] });
  });

  it('a skipped symbol that is not held does not block the signal', async () => {
    await seedSettlements();
    const taker = rvInitialState();
    taker.positions.SOLUSDT = { qty: 2, avgEntry: 100, lastMark: 100 };
    await RvBook.create({
      bookName: RV_BOOK_NAME,
      version: 'rv-v1',
      startedAt: new Date(T0),
      tracks: { taker, maker: rvInitialState() },
    });
    mocks.fetchPerpKlines.mockImplementation(async (symbol: string) => {
      if (symbol === 'XRPUSDT') throw new Error('HTTP 503');
      return klines(symbol);
    });
    const res = await runRvSignal(NOW, OPTS);
    expect(res).toMatchObject({ success: true, created: true, skipped: [{ symbol: 'XRPUSDT', reason: 'bars_incomplete' }] });
  });

  it('D10: re-running for the same bar never rewrites the stored signal, even on different data', async () => {
    await seedSettlements();
    const first = await runRvSignal(NOW, OPTS);
    expect(first).toMatchObject({ success: true, created: true });
    const before = await RvSignal.findOne().lean();

    // The retry sees different prices and a failing symbol
    mocks.fetchPerpKlines.mockImplementation(async (symbol: string) => {
      if (symbol === 'ETHUSDT') throw new Error('HTTP 503');
      return klines(symbol, symbol === 'SOLUSDT' ? 3 : 1);
    });
    const second = await runRvSignal(NOW + 30 * 60_000, OPTS);

    expect(second).toEqual({ ...first, created: false });
    expect(await RvSignal.find().lean()).toEqual([before]);
  });

  it('D10: storeRvSignal only ever inserts, so a racing second writer leaves the first document', async () => {
    const base = {
      version: 'rv-v1' as const,
      barTime: T0,
      barCloseTime: T0 + BAR,
      rows: [],
      skipped: [],
      inputs: { lastBarOpenTime: {}, settlement: {} },
    };
    const a = await storeRvSignal({ ...base, ranked: [{ symbol: 'BTCUSDT', compositeZ: 1, rank: 1 }] });
    const b = await storeRvSignal({ ...base, ranked: [{ symbol: 'ETHUSDT', compositeZ: 2, rank: 1 }] });

    expect(a).toEqual({ created: true });
    expect(b).toEqual({ created: false });
    const docs = await RvSignal.find().lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].ranked).toEqual([{ symbol: 'BTCUSDT', compositeZ: 1, rank: 1 }]);
  });
});
