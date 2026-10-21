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
  // 21 settlements spaced 8h apart ending at barClose (including barClose at T)
  return Array.from({ length: 21 }, (_, i) => ({
    fundingTime: barClose - i * (8 * 3600_000),
    fundingRate: (symbolIndex - 15) * 0.0001,
  }));
}

describe('runLabV3Daily', () => {
  const noopSleep = async () => {};
  const mockExchangeInfo = async () =>
    LAB_V3_UNIVERSE.map((symbol) => ({ symbol, status: 'TRADING' }));

  it('writes a new F1-1d signal row when funding history is complete', async () => {
    const deps: LabV3JobDeps = {
      fetchExchangeInfo: mockExchangeInfo,
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
      fetchExchangeInfo: mockExchangeInfo,
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
      fetchExchangeInfo: mockExchangeInfo,
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
      fetchExchangeInfo: mockExchangeInfo,
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

  it('skips symbols listed as SETTLING or absent from exchangeInfo as delisted, never fetches them, and writes row on non-final attempt', async () => {
    const settlingSymbol = LAB_V3_UNIVERSE[0];
    const absentSymbol = LAB_V3_UNIVERSE[1];

    const exchangeInfoList = LAB_V3_UNIVERSE.slice(2).map((symbol) => ({ symbol, status: 'TRADING' }));
    exchangeInfoList.push({ symbol: settlingSymbol, status: 'SETTLING' });

    const fetchedSymbols: string[] = [];
    const sleepSpy = vi.fn(noopSleep);
    const deps: LabV3JobDeps = {
      fetchExchangeInfo: async () => exchangeInfoList,
      fetchFundingHistory: vi.fn(async (symbol) => {
        fetchedSymbols.push(symbol);
        const idx = LAB_V3_UNIVERSE.indexOf(symbol as (typeof LAB_V3_UNIVERSE)[number]);
        return mockFundingHistoryFor(idx >= 0 ? idx : 0, T_DAY);
      }),
      clock: () => T_DAY + 4 * 60_000,
      sleep: sleepSpy,
    };

    const res = await runLabV3Daily(T_DAY + 4 * 60_000, deps, { final: false });
    expect(res.success).toBe(true);
    expect(res.written).toHaveLength(1);
    expect(res.written[0].hypothesis).toBe('F1-1d');
    expect(res.errors).toHaveLength(0);

    // fetchFundingHistory is never called for delisted symbols
    expect(fetchedSymbols).not.toContain(settlingSymbol);
    expect(fetchedSymbols).not.toContain(absentSymbol);
    expect(fetchedSymbols).toHaveLength(28);

    // 100 ms sleep happens only between symbols that are fetched (28 fetched -> 27 sleeps)
    expect(sleepSpy).toHaveBeenCalledTimes(27);
    expect(sleepSpy).toHaveBeenCalledWith(100);

    const doc = await LabSignal.findOne({ version: 'lab-v3', hypothesis: 'F1-1d', barClose: T_DAY }).lean();
    expect(doc).not.toBeNull();
    expect(doc?.skipped).toEqual(
      expect.arrayContaining([
        { symbol: settlingSymbol, reason: 'delisted' },
        { symbol: absentSymbol, reason: 'delisted' },
      ])
    );
  });

  it('handles fetchExchangeInfo throw: waits with fetch_failed when non-final, writes and fetches all 30 when final', async () => {
    const fetchedSymbolsNonFinal: string[] = [];
    const depsNonFinal: LabV3JobDeps = {
      fetchExchangeInfo: async () => {
        throw new Error('exchangeInfo network failure');
      },
      fetchFundingHistory: vi.fn(async (symbol) => {
        fetchedSymbolsNonFinal.push(symbol);
        return mockFundingHistoryFor(0, T_DAY);
      }),
      clock: () => T_DAY + 4 * 60_000,
      sleep: noopSleep,
    };

    // Non-final attempt
    const resNonFinal = await runLabV3Daily(T_DAY + 4 * 60_000, depsNonFinal, { final: false });
    expect(resNonFinal.written).toHaveLength(0);
    expect(resNonFinal.waiting).toEqual([{ hypothesis: 'F1-1d', barClose: T_DAY, reason: 'fetch_failed' }]);
    expect(resNonFinal.errors).toContain('exchangeInfo: exchangeInfo network failure');
    expect(fetchedSymbolsNonFinal).toHaveLength(0);
    expect(await LabSignal.countDocuments()).toBe(0);

    // Final attempt
    const fetchedSymbolsFinal: string[] = [];
    const depsFinal: LabV3JobDeps = {
      fetchExchangeInfo: async () => {
        throw new Error('exchangeInfo network failure');
      },
      fetchFundingHistory: vi.fn(async (symbol) => {
        fetchedSymbolsFinal.push(symbol);
        const idx = LAB_V3_UNIVERSE.indexOf(symbol as (typeof LAB_V3_UNIVERSE)[number]);
        return mockFundingHistoryFor(idx >= 0 ? idx : 0, T_DAY);
      }),
      clock: () => T_DAY + 4 * 60_000,
      sleep: noopSleep,
    };

    const resFinal = await runLabV3Daily(T_DAY + 4 * 60_000, depsFinal, { final: true });
    expect(resFinal.written).toHaveLength(1);
    expect(resFinal.waiting).toHaveLength(0);
    expect(resFinal.errors).toContain('exchangeInfo: exchangeInfo network failure');
    expect(fetchedSymbolsFinal).toHaveLength(30);
    expect(await LabSignal.countDocuments()).toBe(1);
  });

  it('rounds settlement times to boundary: counts print at T + 3 ms and excludes print at T - 7d + 2 ms', async () => {
    const testSymbol = LAB_V3_UNIVERSE[0];
    const roundingPrints: Array<{ fundingTime: number; fundingRate: number }> = [];

    // Print at T - 7d + 2 ms (rounds to T - 7d, excluded by (T - 7d, T])
    roundingPrints.push({
      fundingTime: T_DAY - 7 * DAY_MS + 2,
      fundingRate: 0.0001,
    });

    // 20 prints every 8h at + 2 ms
    for (let k = 1; k < 21; k++) {
      roundingPrints.push({
        fundingTime: T_DAY - 7 * DAY_MS + k * (8 * 3600_000) + 2,
        fundingRate: 0.0001,
      });
    }

    // Print at T + 3 ms (rounds to T, included in (T - 7d, T])
    roundingPrints.push({
      fundingTime: T_DAY + 3,
      fundingRate: 0.0001,
    });

    expect(roundingPrints).toHaveLength(22);

    const deps: LabV3JobDeps = {
      fetchExchangeInfo: mockExchangeInfo,
      fetchFundingHistory: async (symbol) => {
        if (symbol === testSymbol) {
          return roundingPrints;
        }
        const idx = LAB_V3_UNIVERSE.indexOf(symbol as (typeof LAB_V3_UNIVERSE)[number]);
        return mockFundingHistoryFor(idx >= 0 ? idx : 0, T_DAY);
      },
      clock: () => T_DAY + 4 * 60_000,
      sleep: noopSleep,
    };

    const res = await runLabV3Daily(T_DAY + 4 * 60_000, deps);
    expect(res.written).toHaveLength(1);

    const doc = await LabSignal.findOne({ version: 'lab-v3', hypothesis: 'F1-1d', barClose: T_DAY }).lean();
    expect(doc).not.toBeNull();

    const counts = (doc?.inputs as { settlementsCountBySymbol?: Record<string, number> })?.settlementsCountBySymbol;
    expect(counts?.[testSymbol]).toBe(21);

    const rawScores = (doc?.inputs as { rawScores?: Record<string, number> })?.rawScores;
    // 21 settlements * 0.0001 rate = sum 0.0021 => fund7 = -0.0021
    expect(rawScores?.[testSymbol]).toBeCloseTo(-0.0021, 6);
  });

  it('calls fetchFundingHistory with endTime === T + 60_000', async () => {
    const fetchFundingMock = vi.fn<LabV3JobDeps['fetchFundingHistory']>(async (symbol) => {
      const idx = LAB_V3_UNIVERSE.indexOf(symbol as (typeof LAB_V3_UNIVERSE)[number]);
      return mockFundingHistoryFor(idx >= 0 ? idx : 0, T_DAY);
    });

    const deps: LabV3JobDeps = {
      fetchExchangeInfo: mockExchangeInfo,
      fetchFundingHistory: fetchFundingMock,
      clock: () => T_DAY + 4 * 60_000,
      sleep: noopSleep,
    };

    await runLabV3Daily(T_DAY + 4 * 60_000, deps);

    expect(fetchFundingMock).toHaveBeenCalled();
    const calls = fetchFundingMock.mock.calls;
    for (const call of calls) {
      expect(call[1]).toBe(T_DAY - 14 * DAY_MS);
      expect(call[2]).toBe(T_DAY + 60_000);
    }
  });

  it('a coin whose settlements stop at T - 8h makes a non-final attempt write nothing, with waiting reason fetch_failed and error in report.errors', async () => {
    const missingSymbol = LAB_V3_UNIVERSE[0];
    const deps: LabV3JobDeps = {
      fetchExchangeInfo: mockExchangeInfo,
      fetchFundingHistory: async (symbol) => {
        if (symbol === missingSymbol) {
          // 20 settlements in (T - 7d, T], stopping at T - 8h (none at T)
          return Array.from({ length: 20 }, (_, i) => ({
            fundingTime: T_DAY - (i + 1) * (8 * 3600_000),
            fundingRate: 0.0001,
          }));
        }
        const idx = LAB_V3_UNIVERSE.indexOf(symbol as (typeof LAB_V3_UNIVERSE)[number]);
        return mockFundingHistoryFor(idx >= 0 ? idx : 0, T_DAY);
      },
      clock: () => T_DAY + 4 * 60_000,
      sleep: noopSleep,
    };

    const res = await runLabV3Daily(T_DAY + 4 * 60_000, deps, { final: false });
    expect(res.written).toHaveLength(0);
    expect(res.waiting).toEqual([{ hypothesis: 'F1-1d', barClose: T_DAY, reason: 'fetch_failed' }]);
    expect(res.errors).toContain(`${missingSymbol}: no settlement at T`);
    expect(await LabSignal.countDocuments()).toBe(0);
  });

  it('the same input on a final attempt writes the row, with that coin skipped as funding_incomplete and not in the scores', async () => {
    const missingSymbol = LAB_V3_UNIVERSE[0];
    const deps: LabV3JobDeps = {
      fetchExchangeInfo: mockExchangeInfo,
      fetchFundingHistory: async (symbol) => {
        if (symbol === missingSymbol) {
          // 20 settlements in (T - 7d, T], stopping at T - 8h (none at T)
          return Array.from({ length: 20 }, (_, i) => ({
            fundingTime: T_DAY - (i + 1) * (8 * 3600_000),
            fundingRate: 0.0001,
          }));
        }
        const idx = LAB_V3_UNIVERSE.indexOf(symbol as (typeof LAB_V3_UNIVERSE)[number]);
        return mockFundingHistoryFor(idx >= 0 ? idx : 0, T_DAY);
      },
      clock: () => T_DAY + 4 * 60_000,
      sleep: noopSleep,
    };

    const res = await runLabV3Daily(T_DAY + 4 * 60_000, deps, { final: true });
    expect(res.written).toHaveLength(1);
    expect(res.waiting).toHaveLength(0);

    const doc = await LabSignal.findOne({ version: 'lab-v3', hypothesis: 'F1-1d', barClose: T_DAY }).lean();
    expect(doc).not.toBeNull();
    expect(doc?.skipped).toContainEqual({ symbol: missingSymbol, reason: 'funding_incomplete' });

    const rawScores = (doc?.inputs as { rawScores?: Record<string, number> })?.rawScores ?? {};
    expect(rawScores[missingSymbol]).toBeUndefined();

    const scores = doc?.scores as Record<string, number>;
    expect(scores[missingSymbol]).toBeUndefined();
  });
});
