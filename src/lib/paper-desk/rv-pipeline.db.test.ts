// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { PerpKline } from '@/lib/binance-futures';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { FundingSettlement } from '@/lib/models/funding-settlement';
import { RvSignal } from '@/lib/models/rv-signal';
import { RvBook } from '@/lib/models/rv-book';
import { RvStep } from '@/lib/models/rv-step';
import { RV_V1 } from '@/lib/signals/cross-sectional/engine';
import { buildSyntheticUniverse } from '@/lib/signals/cross-sectional/__fixtures__/rv-synthetic';
import { runRvSignal } from '@/lib/signals/cross-sectional/generator';
import { READY_DELAY_MS, runRvDesk } from './rv-desk';

/**
 * The signal job and the desk together. Regression for the review of
 * 4964516: a desk lagging on a pending step plus a transient kline failure
 * stored a signal missing a symbol the desk was about to enter, and the
 * immutable signal then wedged the desk for good.
 */

const mocks = vi.hoisted(() => ({
  fetchPerpKlines: vi.fn(),
  fetchPerpKlinesRange: vi.fn(),
  syncFundingSettlements: vi.fn(),
}));
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/binance-futures', () => ({
  fetchPerpKlines: mocks.fetchPerpKlines,
  fetchPerpKlinesRange: mocks.fetchPerpKlinesRange,
}));
vi.mock('@/lib/funding-settlement-sync', () => ({ syncFundingSettlements: mocks.syncFundingSettlements }));

const BAR = RV_V1.barMs;
const U = buildSyntheticUniverse();
const X = U.barTime;
const SYMS = [...SIGNAL_SYMBOLS];
const OPTS = { retryDelayMs: 0 };
const readyAt = (barTime: number) => barTime + BAR + READY_DELAY_MS;

let server: MongoMemoryServer;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Promise.all([RvBook.init(), RvStep.init(), RvSignal.init(), FundingSettlement.init()]);
}, 30_000);
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

function closedKlines(symbol: string): PerpKline[] {
  const input = U.inputs.find((i) => i.symbol === symbol)!;
  return input.bars.map((b) => ({
    openTime: b.openTime,
    closeTime: b.openTime + BAR - 1,
    open: b.close,
    high: b.close,
    low: b.close,
    close: b.close,
    quoteVolume: 0,
    volume: b.volume,
    trades: 1,
    takerBuyVolume: b.takerBuyVolume as number,
  }));
}

function fillBar(openTime: number): PerpKline[] {
  return [
    { openTime, closeTime: openTime + 3_600_000 - 1, open: 100, high: 101, low: 99, close: 100, quoteVolume: 0, volume: 0, trades: 0, takerBuyVolume: 0 },
  ];
}

async function seedSignal(barTime: number, order: string[]) {
  await RvSignal.create({
    version: 'rv-v1',
    barTime,
    barCloseTime: barTime + BAR,
    rows: order.map((symbol) => ({ symbol, mom: 0, idio: 0, carry: 0, flow: 0, beta: 1, zMom: 0, zIdio: 0, zCarry: 0, zFlow: 0 })),
    ranked: order.map((symbol, i) => ({ symbol, compositeZ: order.length - i, rank: i + 1 })),
    skipped: [],
    inputs: { lastBarOpenTime: {}, settlement: {} },
  });
}

describe('signal job and desk together', () => {
  it('D07: a lagging desk keeps the signal job from storing a bar that skips a symbol the desk will enter', async () => {
    const docs = [];
    for (let t = X - 3 * BAR; t <= X + 4 * BAR; t += BAR) {
      for (const input of U.inputs) {
        const fixture = t === X + BAR;
        docs.push({ symbol: input.symbol, fundingTime: t, rawTime: t + 1, rate: fixture ? input.lastSettlement!.rate : 0.0001, intervalHours: 8 });
      }
    }
    await FundingSettlement.insertMany(docs);
    mocks.syncFundingSettlements.mockImplementation(async (s: string[]) => s.map((symbol) => ({ symbol, inserted: 0, updated: 0 })));
    mocks.fetchPerpKlinesRange.mockImplementation(async (_s: string, _i: string, start: number) => fillBar(start));

    // 1. The desk steps X - 2 bars (BTC, ETH long, DOT, LINK short)
    await seedSignal(X - 2 * BAR, SYMS);
    expect(await runRvDesk(readyAt(X - 2 * BAR), 'a', OPTS)).toMatchObject({ stepped: 1 });

    // 2. X - 1 bar ranks SOL first, so stepping it enters SOL long. Its fill
    //    bar cannot be fetched at the ready time (transient): pending.
    await seedSignal(X - BAR, ['SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'BTCUSDT', 'ETHUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT']);
    mocks.fetchPerpKlinesRange.mockImplementation(async (s: string, _i: string, start: number) => {
      if (s === 'SOLUSDT') throw new Error('HTTP 503');
      return fillBar(start);
    });
    const lag = await runRvDesk(readyAt(X - BAR), 'b', OPTS);
    expect(lag).toMatchObject({ stepped: 0, pending: [{ barTime: X - BAR, reasons: [expect.stringMatching(/^fill_bar_unavailable:SOLUSDT/)] }] });

    // 3. The signal job for X runs while SOL's klines fail twice. SOL is not
    //    held yet, but the unstepped X - 1 bar ranks it, so X is not stored.
    mocks.fetchPerpKlines.mockImplementation(async (s: string) => {
      if (s === 'SOLUSDT') throw new Error('HTTP 503');
      return closedKlines(s);
    });
    const sig = await runRvSignal(X + BAR + 60_000, OPTS);
    expect(sig).toMatchObject({ success: false, code: 'held_symbol_skipped' });
    expect(await RvSignal.countDocuments({ barTime: X })).toBe(0);

    // 4. The retry line finds the venue back and stores X with SOL scored
    mocks.fetchPerpKlines.mockImplementation(async (s: string) => closedKlines(s));
    const retry = await runRvSignal(X + BAR + 31 * 60_000, OPTS);
    expect(retry).toMatchObject({ success: true, created: true, skipped: [] });

    // 5. The desk steps through both bars, nothing left pending or stale
    mocks.fetchPerpKlinesRange.mockImplementation(async (_s: string, _i: string, start: number) => fillBar(start));
    const r1 = await runRvDesk(readyAt(X), 'c', OPTS);
    expect(r1).toMatchObject({ leased: true, stepped: 2, cursor: X, pending: [], stalePending: false });

    await seedSignal(X + BAR, SYMS);
    const r2 = await runRvDesk(readyAt(X + BAR), 'd', OPTS);
    expect(r2).toMatchObject({ stepped: 1, cursor: X + BAR, pending: [], stalePending: false });
  });
});
