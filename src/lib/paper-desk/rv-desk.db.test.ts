// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { PerpKline } from '@/lib/binance-futures';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { FundingSettlement } from '@/lib/models/funding-settlement';
import { RvSignal } from '@/lib/models/rv-signal';
import { RvBook, RV_BOOK_NAME } from '@/lib/models/rv-book';
import { RvStep } from '@/lib/models/rv-step';
import { RV_V1 } from '@/lib/signals/cross-sectional/engine';
import { LEASE_MS, READY_DELAY_MS, runRvDesk } from './rv-desk';

const mocks = vi.hoisted(() => ({
  fetchPerpKlinesRange: vi.fn(),
  syncFundingSettlements: vi.fn(),
}));
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/binance-futures', () => ({ fetchPerpKlinesRange: mocks.fetchPerpKlinesRange }));
vi.mock('@/lib/funding-settlement-sync', () => ({ syncFundingSettlements: mocks.syncFundingSettlements }));

const BAR = RV_V1.barMs;
const H = 3_600_000;
const DAY = 24 * H;
/** Wednesday 2026-09-23 00:00 UTC. */
const T0 = 1_790_121_600_000;
const SYMS = [...SIGNAL_SYMBOLS];
const RATE = 0.0001;
const OPTS = { retryDelayMs: 0 };

const readyAt = (barTime: number) => barTime + BAR + READY_DELAY_MS;
const run = (now: number, owner = 'run-a') => runRvDesk(now, owner, OPTS);

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

/** Fill-bar overrides keyed `SYMBOL@openTime`; null means Binance has no such bar. */
let bars: Map<string, Partial<PerpKline> | null>;

function fillBar(symbol: string, openTime: number): PerpKline[] {
  const key = `${symbol}@${openTime}`;
  const o = bars.get(key);
  if (o === null) return [];
  const open = o?.open ?? 100;
  return [
    {
      openTime,
      closeTime: openTime + H - 1,
      open,
      high: o?.high ?? open * 1.01,
      low: o?.low ?? open * 0.99,
      close: o?.close ?? open,
      quoteVolume: 0,
      volume: 0,
      trades: 0,
      takerBuyVolume: 0,
    },
  ];
}

async function seedSignal(barTime: number, order: string[] = SYMS) {
  await RvSignal.create({
    version: 'rv-v1',
    barTime,
    barCloseTime: barTime + BAR,
    rows: order.map((symbol) => ({
      symbol,
      mom: 0,
      idio: 0,
      carry: 0,
      flow: 0,
      beta: 1,
      zMom: 0,
      zIdio: 0,
      zCarry: 0,
      zFlow: 0,
    })),
    ranked: order.map((symbol, i) => ({ symbol, compositeZ: order.length - i, rank: i + 1 })),
    skipped: [],
    inputs: { lastBarOpenTime: {}, settlement: {} },
  });
}

async function seedSettlements(from: number, to: number) {
  const docs = [];
  for (let t = from; t <= to; t += BAR) {
    for (const symbol of SYMS) docs.push({ symbol, fundingTime: t, rawTime: t + 1, rate: RATE, intervalHours: 8 });
  }
  await FundingSettlement.insertMany(docs);
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await mongoose.connection.db?.dropDatabase();
  await Promise.all([RvBook.init(), RvStep.init(), RvSignal.init(), FundingSettlement.init()]);
  bars = new Map();
  mocks.fetchPerpKlinesRange.mockImplementation(async (symbol: string, _i: string, start: number) => fillBar(symbol, start));
  mocks.syncFundingSettlements.mockImplementation(async (symbols: string[]) =>
    symbols.map((symbol) => ({ symbol, inserted: 0, updated: 0 }))
  );
  await seedSettlements(T0 - DAY, T0 + 7 * DAY);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const book = () => RvBook.findOne({ bookName: RV_BOOK_NAME }).lean();
const steps = () => RvStep.find().sort({ barTime: 1 }).lean();

describe('runRvDesk: first run and cursor', () => {
  it('D09: a fresh book with five stored signals steps only the newest, and a second run steps nothing', async () => {
    for (let k = 0; k < 5; k++) await seedSignal(T0 + k * BAR);
    const newest = T0 + 4 * BAR;

    const first = await run(readyAt(newest));

    expect(first).toEqual({ leased: true, stepped: 1, pending: [], cursor: newest, waiting: 0, capped: false, stalePending: false });
    const stored = await steps();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ bookName: RV_BOOK_NAME, barTime: newest, fillTime: newest + BAR, pendingReasons: [] });
    const b = await book();
    expect(b).toMatchObject({ lastStepBarTime: newest, startBarTime: newest, leaseUntil: null, leaseOwner: null });
    expect(b!.validationStatus).toBe('unvalidated');
    expect(b!.startedAt).toEqual(new Date(readyAt(newest)));
    // The book is a projection of the step at the cursor
    expect(b!.tracks).toEqual(stored[0].bookAfter!.tracks);
    expect(b!.equity).toEqual(stored[0].bookAfter!.equity);
    expect(Object.keys(b!.tracks.taker.positions).sort()).toEqual(['BTCUSDT', 'DOTUSDT', 'ETHUSDT', 'LINKUSDT']);

    const second = await run(readyAt(newest) + 60_000);
    expect(second).toMatchObject({ leased: true, stepped: 0, pending: [], cursor: newest });
    expect(await RvStep.countDocuments()).toBe(1);
  });

  it('records the targets, both tracks, the rebalance hour and the weekday flag', async () => {
    await seedSignal(T0);
    await run(readyAt(T0));
    const [s] = await steps();
    expect(s.targets).toEqual({ BTCUSDT: 0.25, ETHUSDT: 0.25, DOTUSDT: -0.25, LINKUSDT: -0.25 });
    expect(s.rebalanceHourUtc).toBe(8);
    expect(s.isWeekend).toBe(false);
    expect(s.taker!.fills.map((f) => f.kind)).toEqual(['taker', 'taker', 'taker', 'taker']);
    expect(s.maker!.fills.every((f) => f.kind === 'maker')).toBe(true);
    expect(s.taker!.equityAfter).toBeLessThan(s.maker!.equityAfter);
    expect(s.bookAfter!.equity).toEqual({ taker: s.taker!.equityAfter, maker: s.maker!.equityAfter });
  });

  it('a signal younger than close + 1h + 2min stays unstepped, and steps once it is old enough', async () => {
    await seedSignal(T0);
    const close = T0 + BAR;

    const early = await run(close + 62 * 60_000 - 1);
    expect(early).toMatchObject({ stepped: 0, waiting: 1, cursor: null, pending: [] });
    expect(await RvStep.countDocuments()).toBe(0);
    expect(mocks.fetchPerpKlinesRange).not.toHaveBeenCalled();

    const onTime = await run(close + 62 * 60_000);
    expect(onTime).toMatchObject({ stepped: 1, waiting: 0, cursor: T0 });
  });

  it('steps ready signals in order and stops at the first that is not ready', async () => {
    await seedSignal(T0);
    await run(readyAt(T0));
    await seedSignal(T0 + BAR);
    await seedSignal(T0 + 2 * BAR);

    const res = await run(readyAt(T0 + BAR));

    expect(res).toMatchObject({ stepped: 1, waiting: 1, cursor: T0 + BAR });
    expect((await steps()).map((s) => s.barTime)).toEqual([T0, T0 + BAR]);
  });
});

describe('runRvDesk: lease', () => {
  it('D09: of two concurrent runs exactly one takes the lease, and the bar is stepped once', async () => {
    await seedSignal(T0);
    const now = readyAt(T0);
    // Hold the first run inside its step, so the second runs while the lease is taken
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mocks.fetchPerpKlinesRange.mockImplementationOnce(async (symbol: string, _i: string, start: number) => {
      entered();
      await gate;
      return fillBar(symbol, start);
    });

    const first = run(now, 'run-a');
    await inside;
    const second = await run(now, 'run-b');
    release();
    const results = [await first, second];

    expect(results.filter((r) => r.leased)).toHaveLength(1);
    expect(second).toEqual({ leased: false, stepped: 0 });
    expect(results[0]).toMatchObject({ leased: true, stepped: 1 });
    expect(await RvStep.countDocuments()).toBe(1);
    expect(await RvBook.countDocuments()).toBe(1);
    expect(await book()).toMatchObject({ leaseUntil: null, leaseOwner: null, lastStepBarTime: T0 });
  });

  it('D09: two runs started together never step the bar twice', async () => {
    await seedSignal(T0);
    const now = readyAt(T0);
    const results = await Promise.all([run(now, 'run-a'), run(now, 'run-b')]);
    expect(results.reduce((n, r) => n + r.stepped, 0)).toBe(1);
    expect(await RvStep.countDocuments()).toBe(1);
    expect(await RvBook.countDocuments()).toBe(1);
  });

  it('D09: an unexpired lease held by another run blocks this one and is left alone', async () => {
    await seedSignal(T0);
    const now = readyAt(T0);
    await run(now - 60 * 60_000); // creates the book, too early to step
    await RvBook.updateOne({ bookName: RV_BOOK_NAME }, { $set: { leaseOwner: 'other', leaseUntil: new Date(now + 60_000) } });

    expect(await run(now)).toEqual({ leased: false, stepped: 0 });
    expect(await book()).toMatchObject({ leaseOwner: 'other', leaseUntil: new Date(now + 60_000), lastStepBarTime: null });

    // Once it expires the next run takes over
    const later = await run(now + 2 * 60_000);
    expect(later).toMatchObject({ leased: true, stepped: 1 });
  });

  it('D09: a failed run releases its own lease and leaves the cursor', async () => {
    await seedSignal(T0);
    vi.spyOn(RvStep, 'updateOne').mockRejectedValueOnce(new Error('disk full'));

    await expect(run(readyAt(T0))).rejects.toThrow('disk full');

    expect(await book()).toMatchObject({ leaseOwner: null, leaseUntil: null, lastStepBarTime: null });
  });

  it('D09: a run whose lease was taken over does not write the book and does not clear the new lease', async () => {
    await seedSignal(T0);
    const now = readyAt(T0);
    const original = RvStep.updateOne.bind(RvStep);
    vi.spyOn(RvStep, 'updateOne').mockImplementationOnce(((...args: Parameters<typeof RvStep.updateOne>) =>
      RvBook.updateOne(
        { bookName: RV_BOOK_NAME },
        { $set: { leaseOwner: 'thief', leaseUntil: new Date(now + LEASE_MS) } }
      ).then(() => original(...args))) as unknown as typeof RvStep.updateOne);

    await expect(run(now)).rejects.toThrow(/lease/);

    expect(await book()).toMatchObject({ leaseOwner: 'thief', lastStepBarTime: null });
  });
});

describe('runRvDesk: replay', () => {
  it('D09: a replay after a cursor rollback rewrites identical RvStep documents and adds none', async () => {
    await seedSignal(T0);
    await run(readyAt(T0));
    // A rotation and price moves, so the replayed steps carry real state
    await seedSignal(T0 + BAR, ['SOLUSDT', 'BTCUSDT', ...SYMS.filter((s) => !['SOLUSDT', 'BTCUSDT'].includes(s))]);
    await seedSignal(T0 + 2 * BAR, ['SOLUSDT', 'XRPUSDT', 'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'DOTUSDT', 'LINKUSDT', 'AVAXUSDT']);
    bars.set(`BTCUSDT@${T0 + 2 * BAR}`, { open: 104 });
    bars.set(`DOTUSDT@${T0 + 2 * BAR}`, { open: 97 });
    bars.set(`SOLUSDT@${T0 + 3 * BAR}`, { open: 110 });
    bars.set(`LINKUSDT@${T0 + 3 * BAR}`, { open: 93, high: 93 });
    const now = readyAt(T0 + 2 * BAR);
    expect(await run(now)).toMatchObject({ stepped: 2, cursor: T0 + 2 * BAR });
    const before = await steps();
    const bookBefore = await book();

    await RvBook.updateOne({ bookName: RV_BOOK_NAME }, { $set: { lastStepBarTime: T0 } });
    const replay = await run(now + 60_000);

    expect(replay).toMatchObject({ stepped: 2, cursor: T0 + 2 * BAR });
    expect(await steps()).toEqual(before);
    expect(await RvStep.countDocuments()).toBe(3);
    const bookAfter = await book();
    for (const field of ['tracks', 'equity', 'peakEquity', 'alerts', 'fillStats', 'lastStepBarTime', 'startBarTime'] as const) {
      expect(bookAfter![field]).toEqual(bookBefore![field]);
    }
  });

  it('refuses to run when the cursor points at a step that was never completed', async () => {
    await seedSignal(T0);
    await run(readyAt(T0) - 1); // creates the book
    await RvBook.updateOne({ bookName: RV_BOOK_NAME }, { $set: { lastStepBarTime: T0 - BAR } });
    await expect(run(readyAt(T0))).rejects.toThrow(/no completed RvStep at the cursor/);
    expect(await book()).toMatchObject({ leaseOwner: null, leaseUntil: null });
  });
});

describe('runRvDesk: data failures leave the step pending', () => {
  it('D07: a held symbol missing from the new ranking leaves the step pending and trades nothing', async () => {
    await seedSignal(T0);
    await run(readyAt(T0));
    const bookBefore = await book();
    const [stepBefore] = await steps();
    await seedSignal(T0 + BAR, SYMS.filter((s) => s !== 'ETHUSDT'));

    const res = await run(readyAt(T0 + BAR));

    expect(res).toMatchObject({ stepped: 0, cursor: T0 });
    expect(res.leased && res.pending).toEqual([{ barTime: T0 + BAR, reasons: [expect.stringMatching(/^held_symbol_unscored: ETHUSDT/)] }]);
    const [first, pending] = await steps();
    expect(first).toEqual(stepBefore);
    expect(pending).toMatchObject({ barTime: T0 + BAR, taker: null, maker: null, bookAfter: null, targets: null });
    expect(pending.pendingReasons).toEqual([expect.stringMatching(/^held_symbol_unscored/)]);
    const b = await book();
    expect(b!.tracks).toEqual(bookBefore!.tracks);
    expect(b!.lastStepBarTime).toBe(T0);
    expect(b!.tracks.taker.positions.ETHUSDT.qty).toBeGreaterThan(0);
  });

  it('a pending step completes in place once its data arrives', async () => {
    await seedSignal(T0);
    await run(readyAt(T0));
    await seedSignal(T0 + BAR);
    await FundingSettlement.deleteOne({ symbol: 'ETHUSDT', fundingTime: T0 + 2 * BAR });
    await run(readyAt(T0 + BAR));
    expect((await steps())[1].pendingReasons).toEqual(['funding_missing:ETHUSDT']);

    await FundingSettlement.create({ symbol: 'ETHUSDT', fundingTime: T0 + 2 * BAR, rawTime: T0 + 2 * BAR + 1, rate: RATE });
    const res = await run(readyAt(T0 + BAR) + BAR);

    expect(res).toMatchObject({ stepped: 1, pending: [], cursor: T0 + BAR });
    const stored = await steps();
    expect(stored).toHaveLength(2);
    expect(stored[1]).toMatchObject({ pendingReasons: [], barTime: T0 + BAR });
    expect(stored[1].taker).not.toBeNull();
  });

  it('D16: a held symbol with no settlement at fillTime gets one sync attempt, then funding_missing:SYM', async () => {
    await seedSignal(T0);
    await run(readyAt(T0));
    await seedSignal(T0 + BAR);
    await FundingSettlement.deleteOne({ symbol: 'ETHUSDT', fundingTime: T0 + 2 * BAR });
    const now = readyAt(T0 + BAR);

    const res = await run(now);

    expect(mocks.syncFundingSettlements).toHaveBeenCalledTimes(1);
    expect(mocks.syncFundingSettlements).toHaveBeenCalledWith(['BTCUSDT', 'DOTUSDT', 'ETHUSDT', 'LINKUSDT'], now);
    expect(res).toMatchObject({ stepped: 0, cursor: T0, pending: [{ barTime: T0 + BAR, reasons: ['funding_missing:ETHUSDT'] }] });
  });

  it('D16: a sync that brings the missing settlement in lets the step proceed in the same run', async () => {
    await seedSignal(T0);
    await run(readyAt(T0));
    await seedSignal(T0 + BAR);
    await FundingSettlement.deleteOne({ symbol: 'ETHUSDT', fundingTime: T0 + 2 * BAR });
    mocks.syncFundingSettlements.mockImplementationOnce(async (symbols: string[]) => {
      await FundingSettlement.create({ symbol: 'ETHUSDT', fundingTime: T0 + 2 * BAR, rawTime: T0 + 2 * BAR + 3, rate: RATE, source: 'rest' });
      return symbols.map((symbol) => ({ symbol, inserted: symbol === 'ETHUSDT' ? 1 : 0, updated: 0 }));
    });

    const res = await run(readyAt(T0 + BAR));

    expect(res).toMatchObject({ stepped: 1, pending: [], cursor: T0 + BAR });
  });

  it('D16: across a missing signal every settlement crossed is charged, and a missing one in between is pending', async () => {
    await seedSignal(T0);
    await run(readyAt(T0));
    await seedSignal(T0 + 2 * BAR); // the signal for T0 + BAR never arrived

    await FundingSettlement.deleteOne({ symbol: 'LINKUSDT', fundingTime: T0 + 2 * BAR });
    const blocked = await run(readyAt(T0 + 2 * BAR));
    expect(blocked).toMatchObject({ stepped: 0, pending: [{ barTime: T0 + 2 * BAR, reasons: ['funding_missing:LINKUSDT'] }] });

    await FundingSettlement.create({ symbol: 'LINKUSDT', fundingTime: T0 + 2 * BAR, rawTime: T0 + 2 * BAR + 1, rate: RATE });
    const res = await run(readyAt(T0 + 2 * BAR) + 60_000);
    expect(res).toMatchObject({ stepped: 1, cursor: T0 + 2 * BAR });

    const s = (await steps())[1];
    const funding = s.taker!.funding;
    expect(funding).toHaveLength(8);
    for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
      expect(funding.filter((f) => f.symbol === symbol).map((f) => f.fundingTime)).toEqual([T0 + 2 * BAR, T0 + 3 * BAR]);
      for (const f of funding.filter((x) => x.symbol === symbol)) expect(f.amount).toBeCloseTo(-25 * 100 * RATE, 10);
    }
    for (const f of funding.filter((x) => x.symbol === 'DOTUSDT')) expect(f.amount).toBeCloseTo(25 * 100 * RATE, 10);
  });

  it('a fill bar that cannot be fetched after one retry leaves the step pending, to be retried next run', async () => {
    await seedSignal(T0);
    await run(readyAt(T0));
    await seedSignal(T0 + BAR);
    mocks.fetchPerpKlinesRange.mockImplementation(async (symbol: string, _i: string, start: number) => {
      if (symbol === 'ETHUSDT') throw new Error('HTTP 503');
      return fillBar(symbol, start);
    });

    const res = await run(readyAt(T0 + BAR));

    expect(res).toMatchObject({ stepped: 0, cursor: T0, pending: [{ barTime: T0 + BAR, reasons: ['fill_bar_unavailable:ETHUSDT'] }] });
    const ethCalls = mocks.fetchPerpKlinesRange.mock.calls.filter(([s, , start]) => s === 'ETHUSDT' && start === T0 + 2 * BAR);
    expect(ethCalls).toHaveLength(2);
    expect(mocks.fetchPerpKlinesRange).toHaveBeenCalledWith('BTCUSDT', '1h', T0 + 2 * BAR, T0 + 2 * BAR);
  });

  it('a fill bar Binance does not have marks the held leg stale and keeps it unchanged', async () => {
    await seedSignal(T0);
    await run(readyAt(T0));
    const ethBefore = (await book())!.tracks.taker.positions.ETHUSDT;
    await seedSignal(T0 + BAR);
    bars.set(`ETHUSDT@${T0 + 2 * BAR}`, null);

    const res = await run(readyAt(T0 + BAR));

    expect(res).toMatchObject({ stepped: 1, pending: [] });
    const s = (await steps())[1];
    expect(s.taker!.stale).toEqual(['ETHUSDT']);
    expect(s.taker!.fills.map((f) => f.symbol)).not.toContain('ETHUSDT');
    expect((await book())!.tracks.taker.positions.ETHUSDT).toEqual(ethBefore);
  });

  it('flags a step pending for more than one cadence past its ready time as stale', async () => {
    await seedSignal(T0);
    await run(readyAt(T0));
    await seedSignal(T0 + BAR, SYMS.filter((s) => s !== 'ETHUSDT'));

    const fresh = await run(readyAt(T0 + BAR) + 3 * 60_000);
    expect(fresh).toMatchObject({ stalePending: false });

    const stale = await run(readyAt(T0 + BAR) + BAR + 3 * 60_000);
    expect(stale).toMatchObject({ stalePending: true, pending: [{ barTime: T0 + BAR }] });
  });
});

describe('runRvDesk: alerts and fill statistics', () => {
  it('a 16% drawdown sets the flag but steps continue to trade', async () => {
    await seedSignal(T0);
    await run(readyAt(T0));
    expect((await book())!.alerts).toEqual({ drawdownTaker: false, drawdownMaker: false, negativeStreak: 1 });

    // Both longs fall 32% into the next fill: about 16% of equity
    await seedSignal(T0 + BAR);
    bars.set(`BTCUSDT@${T0 + 2 * BAR}`, { open: 68 });
    bars.set(`ETHUSDT@${T0 + 2 * BAR}`, { open: 68 });
    await run(readyAt(T0 + BAR));

    let b = await book();
    expect(b!.equity.taker / b!.peakEquity.taker).toBeLessThan(0.85);
    expect(b!.equity.taker / b!.peakEquity.taker).toBeGreaterThan(0.83);
    expect(b!.alerts).toEqual({ drawdownTaker: true, drawdownMaker: true, negativeStreak: 2 });
    expect((await steps())[1].taker!.fills.length).toBeGreaterThan(0);

    await seedSignal(T0 + 2 * BAR);
    bars.set(`BTCUSDT@${T0 + 3 * BAR}`, { open: 68 });
    bars.set(`ETHUSDT@${T0 + 3 * BAR}`, { open: 68 });
    const next = await run(readyAt(T0 + 2 * BAR));
    expect(next).toMatchObject({ stepped: 1 });
    expect((await steps())[2].taker!.fills.length).toBeGreaterThan(0);
    b = await book();
    expect(b!.alerts.drawdownTaker).toBe(true);
    expect(b!.alerts.negativeStreak).toBe(3);
  });

  it('the negative streak counts falls from one step to the next, not the fees inside a step, and resets on a gain', async () => {
    await seedSignal(T0);
    await run(readyAt(T0));
    // Longs rally into the next fill
    await seedSignal(T0 + BAR);
    bars.set(`BTCUSDT@${T0 + 2 * BAR}`, { open: 110 });
    await run(readyAt(T0 + BAR));
    const b = await book();
    const [first, second] = await steps();
    expect(second.taker!.equityAfter).toBeLessThan(second.taker!.equityBefore); // fees inside the step
    expect(second.taker!.equityAfter).toBeGreaterThan(first.taker!.equityAfter); // but up step on step
    expect(b!.alerts.negativeStreak).toBe(0);
    expect(b!.peakEquity.taker).toBe(second.taker!.equityAfter);
  });

  it('fillStats counts maker fills against fallbacks per rebalance hour and weekday or weekend', async () => {
    await seedSignal(T0); // fills Wednesday 08:00 UTC
    bars.set(`BTCUSDT@${T0 + BAR}`, { low: 100 }); // buy never trades below the open: fallback
    bars.set(`LINKUSDT@${T0 + BAR}`, { high: 100 }); // sell never trades above the open: fallback
    await run(readyAt(T0));

    const zero = { makerFilled: 0, makerFallback: 0, steps: 0 };
    let stats = (await book())!.fillStats;
    expect(stats).toEqual({
      '00': zero,
      '08': { makerFilled: 2, makerFallback: 2, steps: 1 },
      '16': zero,
      weekday: { makerFilled: 2, makerFallback: 2, steps: 1 },
      weekend: zero,
    });
    const [s] = await steps();
    expect(Object.fromEntries(s.maker!.fills.map((f) => [f.symbol, f.kind]))).toEqual({
      BTCUSDT: 'taker_fallback',
      DOTUSDT: 'maker',
      ETHUSDT: 'maker',
      LINKUSDT: 'taker_fallback',
    });

    // Saturday 16:00 UTC fill: the signal for the bar opening Saturday 08:00
    const saturday = T0 + 3 * DAY + BAR;
    await seedSignal(saturday);
    await run(readyAt(saturday));
    const [, weekendStep] = await steps();
    expect(weekendStep).toMatchObject({ rebalanceHourUtc: 16, isWeekend: true });
    stats = (await book())!.fillStats;
    expect(stats['16']).toEqual({ makerFilled: 4, makerFallback: 0, steps: 1 });
    expect(stats.weekend).toEqual({ makerFilled: 4, makerFallback: 0, steps: 1 });
    expect(stats['08']).toEqual({ makerFilled: 2, makerFallback: 2, steps: 1 });
    expect(stats.weekday).toEqual({ makerFilled: 2, makerFallback: 2, steps: 1 });
  });
});

describe('runRvDesk: legacy records', () => {
  it('leaves the archived crosssectional collections untouched', async () => {
    const db = mongoose.connection.db!;
    await db.collection('crosssectionalbooks').insertOne({ bookName: 'rv-8h-buffer2', equityMaker: 10_123, equityTaker: 9_876, lastProcessedBarTime: T0 - BAR });
    await db.collection('crosssectionalsignals').insertOne({ timestamp: T0 - BAR, targets: [{ symbol: 'BTCUSDT', weight: 0.25, side: 'long' }] });
    await db.collection('crosssectionaltrades').insertOne({ bookName: 'rv-8h-buffer2', symbol: 'ETHUSDT', exitTime: T0 - BAR });
    const snapshot = async () =>
      Promise.all(['crosssectionalbooks', 'crosssectionalsignals', 'crosssectionaltrades'].map((c) => db.collection(c).find().toArray()));
    const before = await snapshot();

    await seedSignal(T0);
    await run(readyAt(T0));
    await seedSignal(T0 + BAR);
    await run(readyAt(T0 + BAR));

    expect(await snapshot()).toEqual(before);
  });
});
