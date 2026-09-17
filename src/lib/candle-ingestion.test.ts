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
      dropOpenBars,
    } = await import('./candle-ingestion');
    const { Candle } = await import('@/lib/models/candle');
    return {
      fetchKlinesRange: fetchKlinesRange as ReturnType<typeof vi.fn>,
      backfillCandles,
      syncCandles,
      getCandles,
      getCandleRange,
      dropOpenBars,
      Candle,
    };
  }

  describe('dropOpenBars', () => {
    it('keeps a bar closing exactly at now and drops one closing after now', async () => {
      const { dropOpenBars } = await importModules();

      const now = 1_000_000;
      const intervalMs = 3_600_000; // '1h'
      const closesAtNow = makeCandle(now - intervalMs);
      const closesAfterNow = makeCandle(now - intervalMs + 1);

      const result = dropOpenBars([closesAtNow, closesAfterNow], '1h', now);

      expect(result).toEqual([closesAtNow]);
    });

    it('returns an empty array when every bar is still open', async () => {
      const { dropOpenBars } = await importModules();

      const now = 1_000_000;
      const result = dropOpenBars([makeCandle(now)], '1h', now);

      expect(result).toEqual([]);
    });
  });

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
    it('round-trips takerBuyVolume and omits it when absent', async () => {
      const { getCandles, Candle } = await importModules();

      await Candle.insertMany([
        { ...makeCandle(1000), symbol: 'BTCUSDT', interval: '1h', takerBuyVolume: 62.5 },
        { ...makeCandle(2000), symbol: 'BTCUSDT', interval: '1h' }, // legacy candle
      ]);

      const candles = await getCandles('BTCUSDT', '1h');

      expect(candles[0].takerBuyVolume).toBe(62.5);
      expect(candles[1].takerBuyVolume).toBeUndefined();
    });

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

  describe('backfillCandles refill mode', () => {
    it('patches takerBuyVolume onto candles already inside the stored range', async () => {
      const { backfillCandles, fetchKlinesRange, getCandles, Candle } =
        await importModules();

      // Rows written before takerBuyVolume existed, spanning the whole window.
      // Already-closed 1h bars, since a refill must not drop them as "open".
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const stamps = [now - 3 * 3_600_000, now - 2 * 3_600_000, now - 3_600_000];
      await Candle.insertMany(
        stamps.map((ts) => ({ ...makeCandle(ts), symbol: 'BTCUSDT', interval: '1h' }))
      );
      expect(
        await Candle.countDocuments({ takerBuyVolume: { $exists: true } })
      ).toBe(0);

      fetchKlinesRange.mockResolvedValue(
        stamps.map((ts) => ({ ...makeCandle(ts), takerBuyVolume: 0.42 }))
      );

      const result = await backfillCandles('BTCUSDT', '1h', 1, { refill: true });

      // Nothing new was created, so `inserted` stays 0 even though every row
      // was patched. This is why a refill must be judged by the field itself.
      expect(result.inserted).toBe(0);
      expect(await Candle.countDocuments({ takerBuyVolume: { $exists: true } })).toBe(3);
      const stored = await getCandles('BTCUSDT', '1h');
      expect(stored.map((c) => c.takerBuyVolume)).toEqual([0.42, 0.42, 0.42]);
    });

    it('leaves in-range candles untouched without refill, which is the defect it fixes', async () => {
      const { backfillCandles, fetchKlinesRange, Candle } = await importModules();

      const now = Date.now();
      const stamps = [now - 3000, now - 2000, now - 1000];
      await Candle.insertMany(
        stamps.map((ts) => ({ ...makeCandle(ts), symbol: 'BTCUSDT', interval: '1h' }))
      );

      fetchKlinesRange.mockResolvedValue([]);

      await backfillCandles('BTCUSDT', '1h', 1);

      expect(await Candle.countDocuments({ takerBuyVolume: { $exists: true } })).toBe(0);
    });

    it('reports a total that does not double-count re-fetched rows', async () => {
      const { backfillCandles, fetchKlinesRange, Candle } = await importModules();

      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const stamps = [now - 2 * 3_600_000, now - 3_600_000];
      await Candle.insertMany(
        stamps.map((ts) => ({ ...makeCandle(ts), symbol: 'BTCUSDT', interval: '1h' }))
      );

      fetchKlinesRange.mockResolvedValue(
        stamps.map((ts) => ({ ...makeCandle(ts), takerBuyVolume: 1 }))
      );

      const result = await backfillCandles('BTCUSDT', '1h', 1, { refill: true });

      expect(result.total).toBe(2);
      expect(await Candle.countDocuments({})).toBe(2);
    });

    it('still accepts a bare onProgress callback for existing callers', async () => {
      const { backfillCandles, fetchKlinesRange } = await importModules();

      fetchKlinesRange.mockResolvedValue([makeCandle(1000)]);
      const onProgress = vi.fn();

      await backfillCandles('BTCUSDT', '1h', 1, onProgress);

      expect(onProgress).toHaveBeenCalled();
    });

    it('reports progress when given options', async () => {
      const { backfillCandles, fetchKlinesRange } = await importModules();

      fetchKlinesRange.mockResolvedValue([makeCandle(1000)]);
      const onProgress = vi.fn();

      await backfillCandles('BTCUSDT', '1h', 1, { onProgress, refill: true });

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

    it('stores only the closed bar when the fetch returns a closed bar and an open bar', async () => {
      const { syncCandles, fetchKlinesRange, Candle, getCandles } = await importModules();

      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      await Candle.create({
        ...makeCandle(now - 2 * 3_600_000),
        symbol: 'BTCUSDT',
        interval: '1h',
      });

      const closedBar = makeCandle(now - 3_600_000); // closes exactly at now
      const openBar = makeCandle(now - 3_600_000 + 1); // closes 1ms after now -- still forming
      fetchKlinesRange.mockResolvedValue([closedBar, openBar]);

      const result = await syncCandles('BTCUSDT', '1h');

      expect(result.inserted).toBe(1);
      const stored = await getCandles('BTCUSDT', '1h');
      expect(stored.map((c) => c.timestamp)).toEqual([
        now - 2 * 3_600_000,
        now - 3_600_000,
      ]);
    });
  });

  describe('closed-bar filtering on write', () => {
    it('backfillCandles after-gap fetch stores only the closed bar', async () => {
      const { backfillCandles, fetchKlinesRange, Candle, getCandles } =
        await importModules();

      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      // Old, epoch-relative timestamps so the "gap before existing data"
      // fetch never triggers -- this test targets the after-gap path only.
      await Candle.insertMany(
        [1000, 2000, 3000].map((ts) => ({
          ...makeCandle(ts),
          symbol: 'BTCUSDT',
          interval: '1h',
        }))
      );

      const closedBar = makeCandle(now - 3_600_000); // closes exactly at now
      const openBar = makeCandle(now - 3_600_000 + 1); // still forming
      fetchKlinesRange.mockResolvedValue([closedBar, openBar]);

      await backfillCandles('BTCUSDT', '1h', 1);

      const stored = await getCandles('BTCUSDT', '1h');
      const timestamps = stored.map((c) => c.timestamp);
      expect(timestamps).toContain(closedBar.timestamp);
      expect(timestamps).not.toContain(openBar.timestamp);
    });

    it('backfillCandles refill drops an open bar returned at the end of the window', async () => {
      const { backfillCandles, fetchKlinesRange, Candle } = await importModules();

      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const stamps = [now - 2 * 3_600_000, now - 3_600_000];

      await Candle.insertMany(
        stamps.map((ts) => ({ ...makeCandle(ts), symbol: 'BTCUSDT', interval: '1h' }))
      );

      const openBar = makeCandle(now - 3_600_000 + 1); // still forming
      fetchKlinesRange.mockResolvedValue([
        ...stamps.map((ts) => makeCandle(ts)),
        openBar,
      ]);

      await backfillCandles('BTCUSDT', '1h', 1, { refill: true });

      expect(await Candle.countDocuments({ timestamp: openBar.timestamp })).toBe(0);
    });

    it('refill over an existing partial row replaces its close, volume, and takerBuyVolume', async () => {
      const { backfillCandles, fetchKlinesRange, getCandles, Candle } =
        await importModules();

      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const ts = now - 3_600_000; // closes exactly at now

      // Written by the old incremental sync while this bar was still open:
      // wrong close/volume, no takerBuyVolume at all.
      await Candle.create({
        symbol: 'BTCUSDT',
        interval: '1h',
        timestamp: ts,
        open: 50000,
        high: 50100,
        low: 49950,
        close: 50050,
        volume: 12,
      });

      fetchKlinesRange.mockResolvedValue([
        {
          timestamp: ts,
          open: 50000,
          high: 50300,
          low: 49900,
          close: 50275,
          volume: 88,
          takerBuyVolume: 40,
        },
      ]);

      await backfillCandles('BTCUSDT', '1h', 1, { refill: true });

      const [stored] = await getCandles('BTCUSDT', '1h');
      expect(stored.close).toBe(50275);
      expect(stored.volume).toBe(88);
      expect(stored.takerBuyVolume).toBe(40);
    });
  });
});
