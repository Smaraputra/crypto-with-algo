// @vitest-environment node
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LabSignal } from '@/lib/models/lab-signal';
import { runLabV2Daily, runLabV2Weekly, type LabV2JobDeps } from '@/lib/signals/lab/job-signals-v2';
import { DAY_MS, n2BookAt, n2HistoryNeeded, type Bar1d } from '@/lib/signals/lab/v2/n2';
import { n3BarsNeeded } from '@/lib/signals/lab/v2/n3';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import type { OHLCV } from '@/types/market';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

let mongoServer: MongoMemoryServer;

// Monday, 2026-10-19 00:00:00 UTC
const T_MON = Date.UTC(2026, 9, 19, 0, 0, 0);
// Sunday, 2026-10-18 00:00:00 UTC
const T_DAY = Date.UTC(2026, 9, 18, 0, 0, 0);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await LabSignal.init();
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
  await LabSignal.createIndexes();
});

function generateDailyOHLCV(startTime: number, endTime: number): Record<string, OHLCV[]> {
  const result: Record<string, OHLCV[]> = {};
  for (const sym of SIGNAL_SYMBOLS) {
    const candles: OHLCV[] = [];
    let cur = startTime;
    let idx = 0;
    while (cur <= endTime) {
      candles.push({
        timestamp: cur,
        open: 100 + (idx % 7),
        high: 110 + (idx % 7),
        low: 90 + (idx % 7),
        close: 105 + (idx % 7),
        volume: 1000 + idx,
        takerBuyVolume: 500 + idx,
      });
      cur += DAY_MS;
      idx++;
    }
    result[sym] = candles;
  }
  return result;
}

function mapToBar1d(k: OHLCV): Bar1d {
  return {
    t: k.timestamp,
    o: k.open,
    h: k.high,
    l: k.low,
    c: k.close,
    v: k.volume,
    ...(k.takerBuyVolume !== undefined ? { tbv: k.takerBuyVolume } : {}),
  };
}

function generate15mDayBars(dayStart: number, basePrice: number, barCount = 96): OHLCV[] {
  const bars: OHLCV[] = [];
  for (let i = 0; i < barCount; i++) {
    bars.push({
      timestamp: dayStart + i * 15 * 60_000,
      open: basePrice,
      high: basePrice + 10,
      low: basePrice - 10,
      close: basePrice,
      volume: 100,
    });
  }
  return bars;
}

describe('job-signals-v2 weekly (N2-1w)', () => {
  let fetchKlinesRange: ReturnType<typeof vi.fn>;
  let clockTime: number;
  let deps: LabV2JobDeps;

  beforeEach(() => {
    fetchKlinesRange = vi.fn();
    clockTime = T_MON + 3 * 60_000;
    deps = {
      fetchKlinesRange: fetchKlinesRange as unknown as LabV2JobDeps['fetchKlinesRange'],
      clock: () => clockTime,
    };
  });

  it('writes row with barClose = Monday and scores equal to n2BookAt.weights for fake candles', async () => {
    const { startTime, endTime } = n2HistoryNeeded(T_MON);
    const fakeData = generateDailyOHLCV(startTime, endTime);
    fetchKlinesRange.mockImplementation(async (sym: string) => fakeData[sym]);

    const report = await runLabV2Weekly(clockTime, deps);

    expect(report.written).toEqual([{ hypothesis: 'N2-1w', barClose: T_MON, late: false }]);
    expect(report.waiting).toEqual([]);
    expect(report.errors).toEqual([]);

    const row = await LabSignal.findOne({
      version: 'lab-v2',
      hypothesis: 'N2-1w',
      barClose: T_MON,
    }).lean();

    expect(row).not.toBeNull();
    expect(row?.candidate).toBe('N2');
    expect(row?.timeframe).toBe('1w');
    expect(row?.barClose).toBe(T_MON);
    expect(row?.late).toBe(false);
    expect(row?.skipped).toEqual([]);

    const candlesMapped: Record<string, Bar1d[]> = {};
    for (const sym of SIGNAL_SYMBOLS) {
      candlesMapped[sym] = (fakeData[sym] ?? []).map(mapToBar1d).filter((b) => b.t < T_MON);
    }
    const expectedBook = n2BookAt(candlesMapped, T_MON);
    expect(row?.scores).toEqual(expectedBook.weights);
    expect(row?.inputs.reason).toBe(expectedBook.reason);
    expect(row?.inputs.cash).toBe(expectedBook.cash);
    expect(row?.inputs.predictions).toEqual(expectedBook.predictions);
    expect(row?.inputs.eligible).toEqual(expectedBook.eligible);
    expect(typeof row?.inputs.inputsSha256).toBe('string');
    expect((row?.inputs.inputsSha256 as string).length).toBe(64);
  });

  it('marks late: true when clock is past T + 10 min', async () => {
    clockTime = T_MON + 11 * 60_000;
    const { startTime, endTime } = n2HistoryNeeded(T_MON);
    const fakeData = generateDailyOHLCV(startTime, endTime);
    fetchKlinesRange.mockImplementation(async (sym: string) => fakeData[sym]);

    const report = await runLabV2Weekly(clockTime, deps);
    expect(report.written).toEqual([{ hypothesis: 'N2-1w', barClose: T_MON, late: true }]);

    const row = await LabSignal.findOne({
      version: 'lab-v2',
      hypothesis: 'N2-1w',
      barClose: T_MON,
    }).lean();
    expect(row?.late).toBe(true);
  });

  it('writes nothing when row already exists and reports waiting: exists', async () => {
    await LabSignal.create({
      version: 'lab-v2',
      hypothesis: 'N2-1w',
      candidate: 'N2',
      timeframe: '1w',
      barClose: T_MON,
      writtenAt: new Date(T_MON),
      late: false,
      scores: {},
      skipped: [],
      inputs: {},
    });

    const report = await runLabV2Weekly(clockTime, deps);
    expect(report.written).toEqual([]);
    expect(report.waiting).toEqual([{ hypothesis: 'N2-1w', barClose: T_MON, reason: 'exists' }]);
    expect(fetchKlinesRange).not.toHaveBeenCalled();
  });

  it('writes nothing and reports waiting: fetch_failed on first attempt if fetch fails', async () => {
    fetchKlinesRange.mockRejectedValue(new Error('Binance 502 Bad Gateway'));

    const report = await runLabV2Weekly(clockTime, deps, { final: false });
    expect(report.written).toEqual([]);
    expect(report.waiting).toEqual([{ hypothesis: 'N2-1w', barClose: T_MON, reason: 'fetch_failed' }]);
    expect(report.errors.length).toBeGreaterThan(0);

    const count = await LabSignal.countDocuments({ version: 'lab-v2', hypothesis: 'N2-1w', barClose: T_MON });
    expect(count).toBe(0);
  });

  it('proceeds on final attempt if fetch fails for one coin', async () => {
    const { startTime, endTime } = n2HistoryNeeded(T_MON);
    const fakeData = generateDailyOHLCV(startTime, endTime);
    fetchKlinesRange.mockImplementation(async (sym: string) => {
      if (sym === 'ETHUSDT') throw new Error('ETH failed');
      return fakeData[sym];
    });

    const report = await runLabV2Weekly(clockTime, deps, { final: true });
    expect(report.written).toEqual([{ hypothesis: 'N2-1w', barClose: T_MON, late: false }]);

    const row = await LabSignal.findOne({ version: 'lab-v2', hypothesis: 'N2-1w', barClose: T_MON }).lean();
    expect(row).not.toBeNull();
    const candleCounts = row?.inputs.candleCounts as Record<string, number>;
    expect(candleCounts['ETHUSDT']).toBe(0);
    expect(candleCounts['BTCUSDT']).toBeGreaterThan(0);
  });
});

describe('job-signals-v2 daily (N3-1d)', () => {
  let fetchKlinesRange: ReturnType<typeof vi.fn>;
  let clockTime: number;
  let deps: LabV2JobDeps;

  beforeEach(() => {
    fetchKlinesRange = vi.fn();
    clockTime = T_DAY + 3 * 60_000;
    deps = {
      fetchKlinesRange: fetchKlinesRange as unknown as LabV2JobDeps['fetchKlinesRange'],
      clock: () => clockTime,
    };
  });

  it('scores equal n3Position values for fake 15m bars (+1, -1, 0) and skips 60-bar day with va_incomplete', async () => {
    const d1 = T_DAY - 1 * DAY_MS;
    const d2 = T_DAY - 2 * DAY_MS;
    const d3 = T_DAY - 3 * DAY_MS;

    const barsMap: Record<string, OHLCV[]> = {};

    // Symbol 0 (BTCUSDT): rising prices -> +1
    // D-3: 100, D-2: 120, D-1: 140
    barsMap[SIGNAL_SYMBOLS[0]] = [
      ...generate15mDayBars(d3, 100, 96),
      ...generate15mDayBars(d2, 120, 96),
      ...generate15mDayBars(d1, 140, 96),
    ];

    // Symbol 1 (ETHUSDT): falling prices -> -1
    // D-3: 140, D-2: 120, D-1: 100
    barsMap[SIGNAL_SYMBOLS[1]] = [
      ...generate15mDayBars(d3, 140, 96),
      ...generate15mDayBars(d2, 120, 96),
      ...generate15mDayBars(d1, 100, 96),
    ];

    // Symbol 2 (BNBUSDT): flat prices -> 0
    // D-3: 100, D-2: 100, D-1: 100
    barsMap[SIGNAL_SYMBOLS[2]] = [
      ...generate15mDayBars(d3, 100, 96),
      ...generate15mDayBars(d2, 100, 96),
      ...generate15mDayBars(d1, 100, 96),
    ];

    // Symbol 3 (SOLUSDT): 60-bar day at D-1 -> va_incomplete
    barsMap[SIGNAL_SYMBOLS[3]] = [
      ...generate15mDayBars(d3, 100, 96),
      ...generate15mDayBars(d2, 100, 96),
      ...generate15mDayBars(d1, 100, 60),
    ];

    // Other symbols: flat
    for (let i = 4; i < SIGNAL_SYMBOLS.length; i++) {
      barsMap[SIGNAL_SYMBOLS[i]] = [
        ...generate15mDayBars(d3, 100, 96),
        ...generate15mDayBars(d2, 100, 96),
        ...generate15mDayBars(d1, 100, 96),
      ];
    }

    fetchKlinesRange.mockImplementation(async (sym: string) => barsMap[sym]);

    const report = await runLabV2Daily(clockTime, deps);
    expect(report.written).toEqual([{ hypothesis: 'N3-1d', barClose: T_DAY, late: false }]);

    const row = await LabSignal.findOne({
      version: 'lab-v2',
      hypothesis: 'N3-1d',
      barClose: T_DAY,
    }).lean();

    expect(row).not.toBeNull();
    expect(row?.candidate).toBe('N3');
    expect(row?.timeframe).toBe('1d');
    expect(row?.barClose).toBe(T_DAY);

    // Verify +1, -1, 0 scores
    expect(row?.scores[SIGNAL_SYMBOLS[0]]).toBe(1);
    expect(row?.scores[SIGNAL_SYMBOLS[1]]).toBe(-1);
    expect(row?.scores[SIGNAL_SYMBOLS[2]]).toBeUndefined();

    // Verify coin with 60 bars is skipped with va_incomplete
    expect(row?.skipped).toContainEqual({
      symbol: SIGNAL_SYMBOLS[3],
      reason: 'va_incomplete',
    });
    expect(row?.scores[SIGNAL_SYMBOLS[3]]).toBeUndefined();

    // Verify barCounts in inputs
    const barCounts = row?.inputs.barCounts as Record<string, Record<string, number>>;
    expect(barCounts[SIGNAL_SYMBOLS[3]][String(d1)]).toBe(60);
    expect(barCounts[SIGNAL_SYMBOLS[0]][String(d1)]).toBe(96);
  });

  it('marks late: true when clock is past T + 10 min for daily', async () => {
    clockTime = T_DAY + 11 * 60_000;
    const d1 = T_DAY - 1 * DAY_MS;
    const d2 = T_DAY - 2 * DAY_MS;
    const d3 = T_DAY - 3 * DAY_MS;
    fetchKlinesRange.mockResolvedValue([
      ...generate15mDayBars(d3, 100, 96),
      ...generate15mDayBars(d2, 100, 96),
      ...generate15mDayBars(d1, 100, 96),
    ]);

    const report = await runLabV2Daily(clockTime, deps);
    expect(report.written).toEqual([{ hypothesis: 'N3-1d', barClose: T_DAY, late: true }]);

    const row = await LabSignal.findOne({ version: 'lab-v2', hypothesis: 'N3-1d', barClose: T_DAY }).lean();
    expect(row?.late).toBe(true);
  });

  it('writes nothing when row already exists for daily', async () => {
    await LabSignal.create({
      version: 'lab-v2',
      hypothesis: 'N3-1d',
      candidate: 'N3',
      timeframe: '1d',
      barClose: T_DAY,
      writtenAt: new Date(T_DAY),
      late: false,
      scores: {},
      skipped: [],
      inputs: {},
    });

    const report = await runLabV2Daily(clockTime, deps);
    expect(report.written).toEqual([]);
    expect(report.waiting).toEqual([{ hypothesis: 'N3-1d', barClose: T_DAY, reason: 'exists' }]);
    expect(fetchKlinesRange).not.toHaveBeenCalled();
  });

  it('writes nothing and reports waiting: fetch_failed on first attempt if fetch fails', async () => {
    fetchKlinesRange.mockRejectedValue(new Error('Binance 500'));

    const report = await runLabV2Daily(clockTime, deps, { final: false });
    expect(report.written).toEqual([]);
    expect(report.waiting).toEqual([{ hypothesis: 'N3-1d', barClose: T_DAY, reason: 'fetch_failed' }]);

    const count = await LabSignal.countDocuments({ version: 'lab-v2', hypothesis: 'N3-1d', barClose: T_DAY });
    expect(count).toBe(0);
  });
});

describe('fetch windows and look-ahead guards', () => {
  let fetchKlinesRange: ReturnType<typeof vi.fn>;
  let clockTime: number;
  let deps: LabV2JobDeps;

  beforeEach(() => {
    fetchKlinesRange = vi.fn();
    clockTime = T_MON + 3 * 60_000;
    deps = {
      fetchKlinesRange: fetchKlinesRange as unknown as LabV2JobDeps['fetchKlinesRange'],
      clock: () => clockTime,
    };
  });

  it('weekly fetch window equals n2HistoryNeeded(T) and excludes candles at or after T', async () => {
    const expectedRange = n2HistoryNeeded(T_MON);
    const fakeData = generateDailyOHLCV(expectedRange.startTime, expectedRange.endTime);

    // Plant a forming bar at T and one after T
    const btcCandlesWithLookahead = [
      ...fakeData['BTCUSDT'],
      {
        timestamp: T_MON,
        open: 200,
        high: 210,
        low: 190,
        close: 205,
        volume: 5000,
      },
      {
        timestamp: T_MON + DAY_MS,
        open: 205,
        high: 215,
        low: 195,
        close: 210,
        volume: 5000,
      },
    ];

    fetchKlinesRange.mockImplementation(async (sym: string) => {
      if (sym === 'BTCUSDT') return btcCandlesWithLookahead;
      return fakeData[sym];
    });

    await runLabV2Weekly(clockTime, deps);

    // Verify fetch window
    for (const call of fetchKlinesRange.mock.calls) {
      expect(call[1]).toBe('1d');
      expect(call[2]).toBe(expectedRange.startTime);
      expect(call[3]).toBe(expectedRange.endTime);
    }

    // Verify row does not contain the lookahead candles
    const row = await LabSignal.findOne({ version: 'lab-v2', hypothesis: 'N2-1w', barClose: T_MON }).lean();
    expect(row).not.toBeNull();
    const candleCounts = row?.inputs.candleCounts as Record<string, number>;
    expect(candleCounts['BTCUSDT']).toBe(fakeData['BTCUSDT'].length);
  });

  it('daily fetch window equals n3BarsNeeded(T) and excludes candles at or after T', async () => {
    const expectedRange = n3BarsNeeded(T_DAY);
    const d1 = T_DAY - 1 * DAY_MS;
    const d2 = T_DAY - 2 * DAY_MS;
    const d3 = T_DAY - 3 * DAY_MS;

    const standardBars = [
      ...generate15mDayBars(d3, 100, 96),
      ...generate15mDayBars(d2, 100, 96),
      ...generate15mDayBars(d1, 100, 96),
    ];

    // Plant a candle at T and after T
    const barsWithLookahead = [
      ...standardBars,
      {
        timestamp: T_DAY,
        open: 100,
        high: 110,
        low: 90,
        close: 100,
        volume: 100,
      },
      {
        timestamp: T_DAY + 15 * 60_000,
        open: 100,
        high: 110,
        low: 90,
        close: 100,
        volume: 100,
      },
    ];

    fetchKlinesRange.mockResolvedValue(barsWithLookahead);

    await runLabV2Daily(T_DAY + 3 * 60_000, deps);

    // Verify fetch window
    for (const call of fetchKlinesRange.mock.calls) {
      expect(call[1]).toBe('15m');
      expect(call[2]).toBe(expectedRange.startTime);
      expect(call[3]).toBe(expectedRange.endTime);
    }

    const row = await LabSignal.findOne({ version: 'lab-v2', hypothesis: 'N3-1d', barClose: T_DAY }).lean();
    expect(row).not.toBeNull();
    const barCounts = row?.inputs.barCounts as Record<string, Record<string, number>>;
    expect(barCounts[SIGNAL_SYMBOLS[0]][String(T_DAY)]).toBeUndefined();
    expect(barCounts[SIGNAL_SYMBOLS[0]][String(d1)]).toBe(96);
  });
});
