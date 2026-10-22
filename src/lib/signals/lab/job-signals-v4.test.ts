// @vitest-environment node
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { LabSignal } from '@/lib/models/lab-signal';
import { runLabV4Hourly, type LabV4JobDeps } from '@/lib/signals/lab/job-signals-v4';
import { HOUR_MS, LAB_V4_WINDOW_BARS } from '@/lib/signals/lab/v4/rules';
import type { OHLCV } from '@/types/market';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

const mocks = vi.hoisted(() => ({
  s1SideAtLast: vi.fn(),
  s2SideAtLast: vi.fn(),
}));

vi.mock('@/lib/signals/lab/v4/rules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/signals/lab/v4/rules')>();
  return {
    ...actual,
    s1SideAtLast: (...args: unknown[]) => mocks.s1SideAtLast(...args),
    s2SideAtLast: (...args: unknown[]) => mocks.s2SideAtLast(...args),
  };
});

let mongoServer: MongoMemoryServer;

const T = Math.floor(1_700_000_000_000 / HOUR_MS) * HOUR_MS;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await LabSignal.init();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
  await LabSignal.createIndexes();
  vi.clearAllMocks();
});

function makeContiguousHourlyBars(barClose: number, count = LAB_V4_WINDOW_BARS + 2): OHLCV[] {
  const firstOpen = barClose - LAB_V4_WINDOW_BARS * HOUR_MS;
  const bars: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    bars.push({
      timestamp: firstOpen + i * HOUR_MS,
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 1000,
      takerBuyVolume: 500,
    });
  }
  return bars;
}

describe('runLabV4Hourly', () => {
  const noopSleep = async () => {};

  it('a symbol whose rule fires is stored with its side', async () => {
    mocks.s1SideAtLast.mockImplementation(() => {
      // Return 1 for BTCUSDT, 0 otherwise
      return 1;
    });
    mocks.s2SideAtLast.mockImplementation(() => {
      return -1;
    });

    const deps: LabV4JobDeps = {
      fetchPerpKlinesOhlcv: async () => makeContiguousHourlyBars(T),
      clock: () => T + 3 * 60_000,
      sleep: noopSleep,
    };

    const res = await runLabV4Hourly(T + 3 * 60_000, deps);
    expect(res.success).toBe(true);
    expect(res.written).toHaveLength(2);
    expect(res.written.map((w) => w.hypothesis)).toEqual(['S1-1h', 'S2-1h']);
    expect(res.written.every((w) => !w.late)).toBe(true);

    const s1Doc = await LabSignal.findOne({ version: 'lab-v4', hypothesis: 'S1-1h', barClose: T }).lean();
    expect(s1Doc).not.toBeNull();
    expect(s1Doc?.candidate).toBe('S1');
    expect(s1Doc?.timeframe).toBe('1h');
    expect(s1Doc?.late).toBe(false);
    expect(s1Doc?.inputs).toEqual({
      windowBars: LAB_V4_WINDOW_BARS,
      lastBarOpen: T - HOUR_MS,
    });
    const s1Scores = s1Doc?.scores as Record<string, number>;
    expect(s1Scores['BTCUSDT']).toBe(1);

    const s2Doc = await LabSignal.findOne({ version: 'lab-v4', hypothesis: 'S2-1h', barClose: T }).lean();
    expect(s2Doc).not.toBeNull();
    expect(s2Doc?.candidate).toBe('S2');
    const s2Scores = s2Doc?.scores as Record<string, number>;
    expect(s2Scores['BTCUSDT']).toBe(-1);
  });

  it('a symbol whose bars are not contiguous is skipped bars_incomplete_v4', async () => {
    mocks.s1SideAtLast.mockReturnValue(1);
    mocks.s2SideAtLast.mockReturnValue(1);

    const deps: LabV4JobDeps = {
      fetchPerpKlinesOhlcv: async (symbol) => {
        if (symbol === 'ETHUSDT') {
          // Return non-contiguous bars (gap of 2h)
          const bars = makeContiguousHourlyBars(T);
          bars[10].timestamp += HOUR_MS;
          return bars;
        }
        return makeContiguousHourlyBars(T);
      },
      clock: () => T + 3 * 60_000,
      sleep: noopSleep,
    };

    const res = await runLabV4Hourly(T + 3 * 60_000, deps);
    expect(res.written).toHaveLength(2);

    const s1Doc = await LabSignal.findOne({ version: 'lab-v4', hypothesis: 'S1-1h', barClose: T }).lean();
    expect(s1Doc?.skipped).toContainEqual({ symbol: 'ETHUSDT', reason: 'bars_incomplete_v4' });
    const s1Scores = s1Doc?.scores as Record<string, number>;
    expect(s1Scores['ETHUSDT']).toBeUndefined();
    expect(s1Scores['BTCUSDT']).toBe(1);

    const s2Doc = await LabSignal.findOne({ version: 'lab-v4', hypothesis: 'S2-1h', barClose: T }).lean();
    expect(s2Doc?.skipped).toContainEqual({ symbol: 'ETHUSDT', reason: 'bars_incomplete_v4' });
  });

  it('a symbol with a non-zero row 3 hours earlier is skipped in_trade, while one with a row exactly 8 hours earlier is not in trade and is stored', async () => {
    const tMinus3h = T - 3 * HOUR_MS;
    const tMinus8h = T - 8 * HOUR_MS;

    await LabSignal.create({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: tMinus3h,
      writtenAt: new Date(tMinus3h + 3 * 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: { windowBars: 720, lastBarOpen: tMinus3h - HOUR_MS },
    });

    await LabSignal.create({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: tMinus8h,
      writtenAt: new Date(tMinus8h + 3 * 60_000),
      late: false,
      scores: { ETHUSDT: 1 },
      skipped: [],
      inputs: { windowBars: 720, lastBarOpen: tMinus8h - HOUR_MS },
    });

    mocks.s1SideAtLast.mockImplementation(() => 1);
    mocks.s2SideAtLast.mockImplementation(() => 0);

    const deps: LabV4JobDeps = {
      fetchPerpKlinesOhlcv: async () => makeContiguousHourlyBars(T),
      clock: () => T + 3 * 60_000,
      sleep: noopSleep,
    };

    const res = await runLabV4Hourly(T + 3 * 60_000, deps);
    expect(res.written).toHaveLength(2);

    const s1Doc = await LabSignal.findOne({ version: 'lab-v4', hypothesis: 'S1-1h', barClose: T }).lean();
    expect(s1Doc?.skipped).toContainEqual({ symbol: 'BTCUSDT', reason: 'in_trade' });
    const scores = s1Doc?.scores as Record<string, number>;
    expect(scores['BTCUSDT']).toBeUndefined();
    expect(scores['ETHUSDT']).toBe(1);
  });

  it('a fetch error on a non-final attempt writes nothing, and on a final attempt writes rows with that symbol skipped', async () => {
    mocks.s1SideAtLast.mockReturnValue(1);
    mocks.s2SideAtLast.mockReturnValue(1);

    const failingDeps: LabV4JobDeps = {
      fetchPerpKlinesOhlcv: async (symbol) => {
        if (symbol === 'SOLUSDT') {
          throw new Error('Binance 502 Bad Gateway');
        }
        return makeContiguousHourlyBars(T);
      },
      clock: () => T + 3 * 60_000,
      sleep: noopSleep,
    };

    // Non-final attempt
    const resNonFinal = await runLabV4Hourly(T + 3 * 60_000, failingDeps, { final: false });
    expect(resNonFinal.written).toHaveLength(0);
    expect(resNonFinal.waiting).toEqual([
      { hypothesis: 'S1-1h', barClose: T, reason: 'fetch_failed' },
      { hypothesis: 'S2-1h', barClose: T, reason: 'fetch_failed' },
    ]);
    expect(resNonFinal.errors).toContain('SOLUSDT: Binance 502 Bad Gateway');
    expect(await LabSignal.countDocuments({ version: 'lab-v4', barClose: T })).toBe(0);

    // Final attempt
    const resFinal = await runLabV4Hourly(T + 3 * 60_000, failingDeps, { final: true });
    expect(resFinal.written).toHaveLength(2);
    expect(resFinal.errors).toContain('SOLUSDT: Binance 502 Bad Gateway');

    const s1Doc = await LabSignal.findOne({ version: 'lab-v4', hypothesis: 'S1-1h', barClose: T }).lean();
    expect(s1Doc?.skipped).toContainEqual({ symbol: 'SOLUSDT', reason: 'bars_incomplete_v4' });
    const s1Scores = s1Doc?.scores as Record<string, number>;
    expect(s1Scores['SOLUSDT']).toBeUndefined();
    expect(s1Scores['BTCUSDT']).toBe(1);
  });

  it('a second run reports exists', async () => {
    mocks.s1SideAtLast.mockReturnValue(0);
    mocks.s2SideAtLast.mockReturnValue(0);

    const deps: LabV4JobDeps = {
      fetchPerpKlinesOhlcv: async () => makeContiguousHourlyBars(T),
      clock: () => T + 3 * 60_000,
      sleep: noopSleep,
    };

    const first = await runLabV4Hourly(T + 3 * 60_000, deps);
    expect(first.written).toHaveLength(2);

    const second = await runLabV4Hourly(T + 4 * 60_000, deps);
    expect(second.written).toHaveLength(0);
    expect(second.waiting).toEqual([
      { hypothesis: 'S1-1h', barClose: T, reason: 'exists' },
      { hypothesis: 'S2-1h', barClose: T, reason: 'exists' },
    ]);
  });

  it('late is true when the clock is past T + D', async () => {
    mocks.s1SideAtLast.mockReturnValue(0);
    mocks.s2SideAtLast.mockReturnValue(0);

    const deps: LabV4JobDeps = {
      fetchPerpKlinesOhlcv: async () => makeContiguousHourlyBars(T),
      // T + D is T + 10 min. Clock at T + 12 min is late.
      clock: () => T + 12 * 60_000,
      sleep: noopSleep,
    };

    const res = await runLabV4Hourly(T + 12 * 60_000, deps);
    expect(res.written).toHaveLength(2);
    expect(res.written.every((w) => w.late)).toBe(true);

    const s1Doc = await LabSignal.findOne({ version: 'lab-v4', hypothesis: 'S1-1h', barClose: T }).lean();
    expect(s1Doc?.late).toBe(true);
  });
});
