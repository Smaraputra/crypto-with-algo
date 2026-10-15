// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { RvBook, RV_BOOK_NAME, type RvBookState } from '@/lib/models/rv-book';
import { RvSignal } from '@/lib/models/rv-signal';
import { RvStep } from '@/lib/models/rv-step';
import { CrossSectionalBook } from '@/lib/models/cross-sectional-book';
import type { RvStepRecord } from '@/lib/signals/cross-sectional/engine';
import type { RvLatestResponse } from '@/lib/paper-desk/rv-latest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), connectDB: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: () => mocks.auth() }));
vi.mock('@/lib/mongodb', () => ({ connectDB: () => mocks.connectDB() }));

import { GET } from './route';

const BAR = 8 * 3_600_000;
/** Wednesday 2026-10-14 00:00 UTC. */
const T0 = 1_791_936_000_000;

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: 'user1' } });
  mocks.connectDB.mockResolvedValue(undefined);
  await mongoose.connection.db?.dropDatabase();
  await Promise.all([RvBook, RvStep, RvSignal, CrossSectionalBook].map((m) => m.createIndexes()));
});

function record(equityAfter: number): RvStepRecord {
  return {
    equityBefore: 10_000,
    equityAfter,
    funding: [],
    fills: [{ symbol: 'BTCUSDT', deltaQty: 0.04, price: 65_000, fee: 1.3, kind: 'taker', realizedPnl: 0 }],
    fees: 1.3,
    realizedPnl: 0,
    unrealizedPnl: 0,
    stale: [],
    skippedEntries: [],
    halted: null,
    gross: 1.04,
  };
}

function bookState(alerts: Partial<RvBookState['alerts']> = {}, equity = 10_000): RvBookState {
  const bucket = () => ({ makerFilled: 0, makerFallback: 0, steps: 0 });
  return {
    tracks: {
      taker: { cash: 7_400, positions: { BTCUSDT: { qty: 0.04, avgEntry: 65_000, lastMark: 65_000 } } },
      maker: { cash: 7_400, positions: { BTCUSDT: { qty: 0.04, avgEntry: 65_000, lastMark: 65_000 } } },
    },
    equity: { taker: equity, maker: equity },
    peakEquity: { taker: 10_000, maker: 10_000 },
    alerts: { drawdownTaker: false, drawdownMaker: false, negativeStreak: 0, ...alerts },
    fillStats: { '00': bucket(), '08': bucket(), '16': bucket(), weekday: bucket(), weekend: bucket() },
  };
}

async function seedSignal(barTime: number) {
  await RvSignal.create({
    version: 'rv-v1',
    barTime,
    barCloseTime: barTime + BAR,
    rows: [],
    ranked: [{ symbol: 'BTCUSDT', compositeZ: 1, rank: 1 }],
    skipped: [{ symbol: 'DOTUSDT', reason: 'carry_stale' }],
    inputs: { lastBarOpenTime: { BTCUSDT: barTime }, settlement: { BTCUSDT: null } },
  });
}

async function seedCompletedStep(barTime: number, state: RvBookState = bookState()) {
  await RvStep.create({
    bookName: RV_BOOK_NAME,
    barTime,
    fillTime: barTime + BAR,
    targets: { BTCUSDT: 0.26 },
    taker: record(state.equity.taker),
    maker: record(state.equity.maker),
    bookAfter: state,
    rebalanceHourUtc: new Date(barTime + BAR).getUTCHours(),
    isWeekend: false,
    pendingReasons: [],
  });
}

async function seedPendingStep(barTime: number) {
  await RvStep.create({
    bookName: RV_BOOK_NAME,
    barTime,
    fillTime: barTime + BAR,
    targets: null,
    taker: null,
    maker: null,
    bookAfter: null,
    rebalanceHourUtc: new Date(barTime + BAR).getUTCHours(),
    isWeekend: false,
    pendingReasons: ['fill_bar_unavailable:SOLUSDT (fetch failed: timeout)'],
  });
}

async function seedBook(cursor: number | null, state: RvBookState = bookState()) {
  await RvBook.create({
    bookName: RV_BOOK_NAME,
    version: 'rv-v1',
    startedAt: new Date(T0 + BAR + 3_900_000),
    startBarTime: T0,
    lastStepBarTime: cursor,
    leaseUntil: new Date(T0 + 10 * BAR),
    leaseOwner: 'run-in-flight',
    ...state,
  });
}

async function get(): Promise<{ status: number; body: RvLatestResponse }> {
  const res = await GET();
  return { status: res.status, body: await res.json() };
}

describe('GET /api/signals/cross-sectional/latest', () => {
  it('returns 401 without a session and reads nothing', async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mocks.connectDB).not.toHaveBeenCalled();
  });

  it('returns null records, the rule costs and no legacy book on an empty database', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      signal: null,
      step: null,
      completedStep: null,
      book: null,
      costs: { takerFee: 0.0005, makerFee: 0.0002, takerSlippageBps: 2 },
      rule: {
        weights: { mom: 0.3, idio: 0.25, carry: 0.3, flow: 0.15 },
        legs: 2,
        startingEquity: 10_000,
        drawdownFlag: 0.15,
      },
      lastAlert: null,
      legacy: null,
    });
  });

  it('returns the newest signal, the newest step and the newest completed step', async () => {
    await seedSignal(T0);
    await seedSignal(T0 + BAR);
    await seedCompletedStep(T0);
    await seedPendingStep(T0 + BAR);
    await seedBook(T0);

    const { body } = await get();
    expect(body.signal).toMatchObject({
      version: 'rv-v1',
      barTime: T0 + BAR,
      barCloseTime: T0 + 2 * BAR,
      ranked: [{ symbol: 'BTCUSDT', compositeZ: 1, rank: 1 }],
      skipped: [{ symbol: 'DOTUSDT', reason: 'carry_stale' }],
    });
    expect(body.step).toMatchObject({
      barTime: T0 + BAR,
      taker: null,
      bookAfter: null,
      pendingReasons: ['fill_bar_unavailable:SOLUSDT (fetch failed: timeout)'],
    });
    expect(body.completedStep).toMatchObject({ barTime: T0, fillTime: T0 + BAR, pendingReasons: [] });
    expect(body.completedStep!.taker!.equityAfter).toBe(10_000);
    expect(body.completedStep!.bookAfter).not.toBeNull();
  });

  it('returns the book without its lease fields', async () => {
    await seedBook(T0, bookState({}, 10_125.5));
    const { body } = await get();
    expect(body.book).not.toHaveProperty('leaseUntil');
    expect(body.book).not.toHaveProperty('leaseOwner');
    expect(body.book).toMatchObject({
      bookName: 'rv-v1',
      version: 'rv-v1',
      validationStatus: 'unvalidated',
      validationRef: null,
      startedAt: new Date(T0 + BAR + 3_900_000).toISOString(),
      startBarTime: T0,
      lastStepBarTime: T0,
      equity: { taker: 10_125.5, maker: 10_125.5 },
      alerts: { drawdownTaker: false, drawdownMaker: false, negativeStreak: 0 },
    });
    expect(body.book!.tracks.taker.positions.BTCUSDT).toEqual({ qty: 0.04, avgEntry: 65_000, lastMark: 65_000 });
  });

  it('reports the newest step that carried a raised flag, with its kinds', async () => {
    await seedCompletedStep(T0, bookState({ drawdownTaker: true, negativeStreak: 10 }));
    await seedCompletedStep(T0 + BAR, bookState({ drawdownMaker: true }));
    await seedCompletedStep(T0 + 2 * BAR, bookState({ negativeStreak: 9 }));
    await seedCompletedStep(T0 + 3 * BAR);
    await seedPendingStep(T0 + 4 * BAR);
    await seedBook(T0 + 3 * BAR);

    const { body } = await get();
    expect(body.lastAlert).toEqual({ barTime: T0 + BAR, fillTime: T0 + 2 * BAR, kinds: ['drawdown_maker'] });
  });

  it('counts a negative streak of 10 as a flag', async () => {
    await seedCompletedStep(T0, bookState({ drawdownTaker: true }));
    await seedCompletedStep(T0 + BAR, bookState({ negativeStreak: 10 }));
    await seedBook(T0 + BAR);

    const { body } = await get();
    expect(body.lastAlert).toEqual({ barTime: T0 + BAR, fillTime: T0 + 2 * BAR, kinds: ['negative_streak'] });
  });

  it('has no last alert when no step ever raised a flag', async () => {
    await seedCompletedStep(T0, bookState({ negativeStreak: 9 }));
    await seedBook(T0);
    const { body } = await get();
    expect(body.lastAlert).toBeNull();
  });

  it('summarises the archived legacy book', async () => {
    await CrossSectionalBook.create({
      bookName: 'rv-8h-buffer2',
      equityMaker: 10_250.75,
      equityTaker: 10_010.25,
      lastProcessedBarTime: T0 - BAR,
      positions: [],
    });
    const { body } = await get();
    expect(body.legacy).toEqual({
      bookName: 'rv-8h-buffer2',
      equityMaker: 10_250.75,
      equityTaker: 10_010.25,
      lastProcessedBarTime: T0 - BAR,
    });
  });

  it('returns 500 with a JSON error when the database is unavailable', async () => {
    mocks.connectDB.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { status, body } = await get();
    expect(status).toBe(500);
    expect(body).toEqual({ success: false, error: 'Could not read the rv-v1 desk' });
  });
});
