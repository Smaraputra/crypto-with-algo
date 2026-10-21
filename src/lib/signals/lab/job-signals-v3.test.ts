// @vitest-environment node
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { LabSignal } from '@/lib/models/lab-signal';
import { LAB_V3_UNIVERSE } from '@/lib/signals/lab/candidates';
import { runLabV3Daily, type LabV3JobDeps } from '@/lib/signals/lab/job-signals-v3';
import { DAY_MS } from '@/lib/signals/lab/v3/f1';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

let mongoServer: MongoMemoryServer;

// Tuesday, 2026-10-20 00:00:00 UTC
const T_DAY = Date.UTC(2026, 9, 20, 0, 0, 0);

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
});

function mockFundingHistoryFor(symbolIndex: number, barClose: number) {
  // 21 settlements spaced 8h apart
  return Array.from({ length: 21 }, (_, i) => ({
    fundingTime: barClose - (i + 0.5) * (8 * 3600_000),
    fundingRate: (symbolIndex - 15) * 0.0001,
  }));
}

describe('runLabV3Daily', () => {
  const noopSleep = async () => {};

  it('writes a new F1-1d signal row when funding history is complete', async () => {
    const deps: LabV3JobDeps = {
      fetchFundingHistory: async (symbol) => {
        const idx = LAB_V3_UNIVERSE.indexOf(symbol as (typeof LAB_V3_UNIVERSE)[number]);
        return mockFundingHistoryFor(idx >= 0 ? idx : 0, T_DAY);
      },
      clock: () => T_DAY + 4 * 60_000, // 00:04 UTC (on time)
      sleep: noopSleep,
    };

    const res = await runLabV3Daily(T_DAY + 4 * 60_000, deps);
    expect(res.success).toBe(true);
    expect(res.written).toHaveLength(1);
    expect(res.written[0]).toEqual({
      hypothesis: 'F1-1d',
      barClose: T_DAY,
      late: false,
    });

    const doc = await LabSignal.findOne({ version: 'lab-v3', hypothesis: 'F1-1d', barClose: T_DAY }).lean();
    expect(doc).not.toBeNull();
    expect(doc?.candidate).toBe('F1');
    expect(doc?.timeframe).toBe('1d');
    expect(doc?.late).toBe(false);

    // Active weights exist for 30 symbols
    const weights = doc?.scores as Record<string, number>;
    expect(Object.keys(weights).length).toBe(30);

    // Dollar-neutral
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(0, 8);
  });

  it('marks late if written after T + D (10 minutes)', async () => {
    const deps: LabV3JobDeps = {
      fetchFundingHistory: async (symbol) => {
        const idx = LAB_V3_UNIVERSE.indexOf(symbol as (typeof LAB_V3_UNIVERSE)[number]);
        return mockFundingHistoryFor(idx >= 0 ? idx : 0, T_DAY);
      },
      clock: () => T_DAY + 15 * 60_000, // 00:15 UTC (late)
      sleep: noopSleep,
    };

    const res = await runLabV3Daily(T_DAY + 15 * 60_000, deps);
    expect(res.written[0].late).toBe(true);

    const doc = await LabSignal.findOne({ version: 'lab-v3', hypothesis: 'F1-1d', barClose: T_DAY }).lean();
    expect(doc?.late).toBe(true);
  });

  it('skips without writing if row already exists', async () => {
    const deps: LabV3JobDeps = {
      fetchFundingHistory: async (symbol) => {
        const idx = LAB_V3_UNIVERSE.indexOf(symbol as (typeof LAB_V3_UNIVERSE)[number]);
        return mockFundingHistoryFor(idx >= 0 ? idx : 0, T_DAY);
      },
      clock: () => T_DAY + 4 * 60_000,
      sleep: noopSleep,
    };

    const first = await runLabV3Daily(T_DAY + 4 * 60_000, deps);
    expect(first.written).toHaveLength(1);

    const second = await runLabV3Daily(T_DAY + 5 * 60_000, deps);
    expect(second.written).toHaveLength(0);
    expect(second.waiting).toEqual([{ hypothesis: 'F1-1d', barClose: T_DAY, reason: 'exists' }]);
  });

  it('incorporates past daily target books into the 7-day staggered book', async () => {
    // Seed past 2 daily rows
    const pastClose1 = T_DAY - 1 * DAY_MS;
    const pastClose2 = T_DAY - 2 * DAY_MS;

    await LabSignal.create({
      version: 'lab-v3',
      hypothesis: 'F1-1d',
      candidate: 'F1',
      timeframe: '1d',
      barClose: pastClose1,
      writtenAt: new Date(pastClose1 + 4 * 60_000),
      late: false,
      scores: { BTCUSDT: 0.1, ETHUSDT: -0.1 },
      skipped: [],
      inputs: {
        targetBook: { BTCUSDT: 0.5, ETHUSDT: -0.5 },
      },
    });

    await LabSignal.create({
      version: 'lab-v3',
      hypothesis: 'F1-1d',
      candidate: 'F1',
      timeframe: '1d',
      barClose: pastClose2,
      writtenAt: new Date(pastClose2 + 4 * 60_000),
      late: false,
      scores: { BTCUSDT: 0.1, ETHUSDT: -0.1 },
      skipped: [],
      inputs: {
        targetBook: { BTCUSDT: 0.2, ETHUSDT: -0.2 },
      },
    });

    const deps: LabV3JobDeps = {
      fetchFundingHistory: async () => [],
      clock: () => T_DAY + 4 * 60_000,
      sleep: noopSleep,
    };

    // Current day has empty target (no funding history), but past 2 days contribute
    const res = await runLabV3Daily(T_DAY + 4 * 60_000, deps, { final: true });
    expect(res.written).toHaveLength(1);

    const doc = await LabSignal.findOne({ version: 'lab-v3', hypothesis: 'F1-1d', barClose: T_DAY }).lean();
    const weights = doc?.scores as Record<string, number>;

    // BTC weight = (0 + 0.5 + 0.2) / 7 = 0.7 / 7 = 0.1
    expect(weights['BTCUSDT']).toBeCloseTo(0.1, 6);
    expect(weights['ETHUSDT']).toBeCloseTo(-0.1, 6);
  });
});
