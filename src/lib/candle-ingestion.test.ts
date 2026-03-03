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
import type { OHLCV } from '@/types/market';

// Mock binance module before importing candle-ingestion
vi.mock('@/lib/binance', () => ({
  fetchKlinesRange: vi.fn(),
  fetchKlines: vi.fn(),
}));

// Mock mongodb module to use memory server
vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

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
  vi.restoreAllMocks();
});

function makeCandle(timestamp: number, close = 50000): OHLCV {
  return {
    timestamp,
    open: close - 100,
    high: close + 200,
    low: close - 200,
    close,
    volume: 100,
  };
}

describe('candle-ingestion', () => {
  async function importModules() {
    const { fetchKlinesRange } = await import('@/lib/binance');
    const {
      backfillCandles,
      syncCandles,
      getCandles,
      getCandleRange,
    } = await import('./candle-ingestion');
    const { Candle } = await import('@/lib/models/candle');
    return {
      fetchKlinesRange: fetchKlinesRange as ReturnType<typeof vi.fn>,
      backfillCandles,
      syncCandles,
      getCandles,
      getCandleRange,
      Candle,
    };
  }

  describe('getCandleRange', () => {
    it('returns nulls for empty collection', async () => {
      const { getCandleRange } = await importModules();
      const range = await getCandleRange('BTCUSDT', '1h');

      expect(range.oldest).toBeNull();
      expect(range.newest).toBeNull();
      expect(range.count).toBe(0);
    });

    it('returns correct range for populated data', async () => {
      const { getCandleRange, Candle } = await importModules();

      await Candle.insertMany([
        makeCandle(1000),
        makeCandle(2000),
        makeCandle(3000),
      ].map((c) => ({ ...c, symbol: 'BTCUSDT', interval: '1h' })));

      const range = await getCandleRange('BTCUSDT', '1h');

      expect(range.oldest).toBe(1000);
      expect(range.newest).toBe(3000);
      expect(range.count).toBe(3);
    });
  });

  describe('getCandles', () => {
    it('returns candles in ascending order', async () => {
      const { getCandles, Candle } = await importModules();

      await Candle.insertMany([
        { ...makeCandle(3000), symbol: 'BTCUSDT', interval: '1h' },
        { ...makeCandle(1000), symbol: 'BTCUSDT', interval: '1h' },
        { ...makeCandle(2000), symbol: 'BTCUSDT', interval: '1h' },
      ]);

      const candles = await getCandles('BTCUSDT', '1h');

      expect(candles).toHaveLength(3);
      expect(candles[0].timestamp).toBe(1000);
      expect(candles[1].timestamp).toBe(2000);
      expect(candles[2].timestamp).toBe(3000);
    });

    it('respects limit parameter and returns most recent candles', async () => {
      const { getCandles, Candle } = await importModules();

      await Candle.insertMany(
        [1000, 2000, 3000, 4000, 5000].map((ts) => ({
          ...makeCandle(ts),
          symbol: 'BTCUSDT',
          interval: '1h',
        }))
      );

      const candles = await getCandles('BTCUSDT', '1h', undefined, undefined, 2);
      expect(candles).toHaveLength(2);
      // Without startTime, limit returns the most recent N candles in ascending order
      expect(candles[0].timestamp).toBe(4000);
      expect(candles[1].timestamp).toBe(5000);
    });

    it('returns oldest candles first when startTime is specified with limit', async () => {
      const { getCandles, Candle } = await importModules();

      await Candle.insertMany(
        [1000, 2000, 3000, 4000, 5000].map((ts) => ({
          ...makeCandle(ts),
          symbol: 'BTCUSDT',
          interval: '1h',
        }))
      );

      const candles = await getCandles('BTCUSDT', '1h', 1000, undefined, 2);
      expect(candles).toHaveLength(2);
      // With startTime, limit returns from startTime ascending
      expect(candles[0].timestamp).toBe(1000);
      expect(candles[1].timestamp).toBe(2000);
    });

    it('filters by startTime and endTime', async () => {
      const { getCandles, Candle } = await importModules();

      await Candle.insertMany(
        [1000, 2000, 3000, 4000, 5000].map((ts) => ({
          ...makeCandle(ts),
          symbol: 'BTCUSDT',
          interval: '1h',
        }))
      );

      const candles = await getCandles('BTCUSDT', '1h', 2000, 4000);
      expect(candles).toHaveLength(3);
      expect(candles[0].timestamp).toBe(2000);
      expect(candles[2].timestamp).toBe(4000);
    });

    it('returns OHLCV shape without mongoose fields', async () => {
      const { getCandles, Candle } = await importModules();

      await Candle.create({
        ...makeCandle(1000),
        symbol: 'BTCUSDT',
        interval: '1h',
      });

      const candles = await getCandles('BTCUSDT', '1h');

      expect(candles[0]).toEqual({
        timestamp: 1000,
        open: expect.any(Number),
        high: expect.any(Number),
        low: expect.any(Number),
        close: expect.any(Number),
        volume: expect.any(Number),
      });
      expect((candles[0] as unknown as Record<string, unknown>)._id).toBeUndefined();
    });
  });

  describe('backfillCandles', () => {
    it('fetches from Binance and stores in DB', async () => {
      const { backfillCandles, fetchKlinesRange, getCandles } =
        await importModules();

      const candles = [makeCandle(1000), makeCandle(2000), makeCandle(3000)];
      fetchKlinesRange.mockResolvedValue(candles);

      const result = await backfillCandles('BTCUSDT', '1h', 1);

      expect(result.inserted).toBe(3);
      expect(fetchKlinesRange).toHaveBeenCalled();

      const stored = await getCandles('BTCUSDT', '1h');
      expect(stored).toHaveLength(3);
    });

    it('skips already-stored ranges', async () => {
      const { backfillCandles, fetchKlinesRange, Candle } =
        await importModules();

      // Pre-populate with some data
      await Candle.insertMany(
        [1000, 2000, 3000].map((ts) => ({
          ...makeCandle(ts),
          symbol: 'BTCUSDT',
          interval: '1h',
        }))
      );

      // Mock returns empty for gap before and some new after existing data
      fetchKlinesRange.mockResolvedValue([makeCandle(4000)]);

      const result = await backfillCandles('BTCUSDT', '1h', 1);

      // Should have inserted the new candle
      expect(result.inserted).toBe(1);
    });

    it('calls onProgress callback', async () => {
      const { backfillCandles, fetchKlinesRange } = await importModules();

      fetchKlinesRange.mockResolvedValue([makeCandle(1000)]);

      const onProgress = vi.fn();
      await backfillCandles('BTCUSDT', '1h', 1, onProgress);

      expect(onProgress).toHaveBeenCalled();
    });
  });

  describe('syncCandles', () => {
    it('fetches from latest stored to now', async () => {
      const { syncCandles, fetchKlinesRange, Candle } = await importModules();

      await Candle.create({
        ...makeCandle(1000),
        symbol: 'BTCUSDT',
        interval: '1h',
      });

      fetchKlinesRange.mockResolvedValue([makeCandle(2000), makeCandle(3000)]);

      const result = await syncCandles('BTCUSDT', '1h');

      expect(result.inserted).toBe(2);
      expect(fetchKlinesRange).toHaveBeenCalledWith(
        'BTCUSDT',
        '1h',
        1001,
        expect.any(Number)
      );
    });

    it('handles empty DB by doing initial backfill', async () => {
      const { syncCandles, fetchKlinesRange } = await importModules();

      fetchKlinesRange.mockResolvedValue([makeCandle(1000)]);

      const result = await syncCandles('BTCUSDT', '1h');

      expect(result.inserted).toBe(1);
    });
  });
});
