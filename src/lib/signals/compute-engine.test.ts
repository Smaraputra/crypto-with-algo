import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { OHLCV } from '@/types/market';

const mockGetCandles = vi.fn();
const mockFetchKlines = vi.fn();
const mockFetchFundingRate = vi.fn();
const mockFetchLongShortRatio = vi.fn();
const mockFetchFearAndGreed = vi.fn();
const mockConnectDB = vi.fn();
const mockInsertMany = vi.fn();
const mockCreate = vi.fn();
const mockFindOne = vi.fn();

vi.mock('@/lib/candle-ingestion', () => ({
  getCandles: (...args: unknown[]) => mockGetCandles(...args),
}));

vi.mock('@/lib/binance', () => ({
  fetchKlines: (...args: unknown[]) => mockFetchKlines(...args),
}));

vi.mock('@/lib/binance-futures', () => ({
  fetchFundingRate: (...args: unknown[]) => mockFetchFundingRate(...args),
  fetchLongShortRatio: (...args: unknown[]) => mockFetchLongShortRatio(...args),
}));

vi.mock('@/lib/external/fear-greed', () => ({
  fetchFearAndGreed: () => mockFetchFearAndGreed(),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: (_key: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: () => mockConnectDB(),
}));

vi.mock('@/lib/models/global-signal', () => ({
  GlobalSignal: {
    insertMany: (...args: unknown[]) => mockInsertMany(...args),
    create: (...args: unknown[]) => mockCreate(...args),
  },
}));

vi.mock('@/lib/models/signal-template', async () => {
  const actual = await vi.importActual('@/lib/models/signal-template');
  return {
    ...actual,
    SignalTemplate: {
      findOne: () => ({ lean: () => mockFindOne() }),
    },
  };
});

function generateCandles(count: number, startPrice = 40000): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = startPrice;
  const baseTime = Date.now() - count * 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    const change = (Math.sin(i * 0.1) * 0.02 + 0.001) * price;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * (1 + Math.random() * 0.005);
    const low = Math.min(open, close) * (1 - Math.random() * 0.005);
    const volume = 100 + Math.random() * 200;

    candles.push({
      timestamp: baseTime + i * 60 * 60 * 1000,
      open,
      high,
      low,
      close,
      volume,
    });
    price = close;
  }
  return candles;
}

describe('compute-engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchFearAndGreed.mockResolvedValue(null);
    mockFetchFundingRate.mockResolvedValue([]);
    mockFetchLongShortRatio.mockResolvedValue([]);
    mockFindOne.mockResolvedValue(null);
    mockInsertMany.mockResolvedValue([]);
  });

  describe('computeSignalBatch', () => {
    it('returns zeros for empty tasks', async () => {
      const { computeSignalBatch } = await import('./compute-engine');
      const result = await computeSignalBatch([]);

      expect(result.computed).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.details).toHaveLength(0);
    });

    it('computes signal for a single task', async () => {
      const candles = generateCandles(500);
      mockGetCandles.mockResolvedValue(candles);
      mockFetchKlines.mockResolvedValue(candles);

      const { computeSignalBatch } = await import('./compute-engine');
      const result = await computeSignalBatch([
        { symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'day_trading' },
      ]);

      expect(result.computed).toBe(1);
      expect(result.errors).toBe(0);
      expect(result.skipped).toBe(0);
      expect(mockInsertMany).toHaveBeenCalledTimes(1);

      const insertedDocs = mockInsertMany.mock.calls[0][0];
      expect(insertedDocs).toHaveLength(1);
      expect(insertedDocs[0].symbol).toBe('BTCUSDT');
      expect(insertedDocs[0].tradingStyle).toBe('day_trading');
      expect(typeof insertedDocs[0].score).toBe('number');
      expect(insertedDocs[0].score).toBeGreaterThanOrEqual(-100);
      expect(insertedDocs[0].score).toBeLessThanOrEqual(100);
      expect(['strong_buy', 'buy', 'neutral', 'sell', 'strong_sell']).toContain(insertedDocs[0].tier);
      expect(insertedDocs[0].expiresAt).toBeInstanceOf(Date);
    });

    it('computes multiple tasks and deduplicates candle fetches', async () => {
      const candles = generateCandles(500);
      mockGetCandles.mockResolvedValue(candles);
      mockFetchKlines.mockResolvedValue(candles);

      const { computeSignalBatch } = await import('./compute-engine');
      const result = await computeSignalBatch([
        { symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'day_trading' },
        { symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'swing_trading' },
      ]);

      expect(result.computed).toBe(2);
      // Both tasks use BTCUSDT:1h, but cachedFetch handles dedup
      expect(mockInsertMany).toHaveBeenCalledTimes(1);
      const insertedDocs = mockInsertMany.mock.calls[0][0];
      expect(insertedDocs).toHaveLength(2);
    });

    it('skips tasks with insufficient candles', async () => {
      const shortCandles = generateCandles(30);
      mockGetCandles.mockResolvedValue(shortCandles);
      mockFetchKlines.mockResolvedValue(shortCandles);

      const { computeSignalBatch } = await import('./compute-engine');
      const result = await computeSignalBatch([
        { symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'day_trading' },
      ]);

      expect(result.computed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.details[0].status).toBe('skipped');
      expect(result.details[0].error).toContain('Insufficient candles');
    });

    it('handles candle fetch errors gracefully', async () => {
      mockGetCandles.mockRejectedValue(new Error('DB error'));
      mockFetchKlines.mockRejectedValue(new Error('API error'));

      const { computeSignalBatch } = await import('./compute-engine');
      const result = await computeSignalBatch([
        { symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'day_trading' },
      ]);

      expect(result.errors).toBe(1);
      expect(result.details[0].status).toBe('error');
    });

    it('uses template weights when available', async () => {
      const candles = generateCandles(500);
      mockGetCandles.mockResolvedValue(candles);
      mockFetchKlines.mockResolvedValue(candles);
      mockFindOne.mockResolvedValue({
        weights: {
          trend: 0.50,
          momentum: 0.20,
          volume: 0.10,
          volatility: 0.05,
          futures: 0.10,
          sentiment: 0.05,
        },
      });

      const { computeSignalBatch } = await import('./compute-engine');
      const result = await computeSignalBatch([
        { symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'day_trading' },
      ]);

      expect(result.computed).toBe(1);
    });

    it('falls back to default weights on template error', async () => {
      const candles = generateCandles(500);
      mockGetCandles.mockResolvedValue(candles);
      mockFetchKlines.mockResolvedValue(candles);
      mockFindOne.mockRejectedValue(new Error('DB error'));

      const { computeSignalBatch } = await import('./compute-engine');
      const result = await computeSignalBatch([
        { symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'day_trading' },
      ]);

      expect(result.computed).toBe(1);
    });

    it('sets correct TTL based on trading style', async () => {
      const candles = generateCandles(100);
      mockGetCandles.mockResolvedValue(candles);
      mockFetchKlines.mockResolvedValue(candles);

      const { computeSignalBatch } = await import('./compute-engine');
      await computeSignalBatch([
        { symbol: 'BTCUSDT', interval: '5m', tradingStyle: 'scalping' },
      ]);

      const insertedDocs = mockInsertMany.mock.calls[0][0];
      const expiresAt = insertedDocs[0].expiresAt as Date;
      const ttlMs = expiresAt.getTime() - Date.now();
      // Scalping TTL is 86400 seconds (1 day), allow 5s tolerance
      expect(ttlMs).toBeGreaterThan(86_400_000 - 5000);
      expect(ttlMs).toBeLessThanOrEqual(86_400_000 + 1000);
    });

    it('fetches sentiment once for multiple tasks', async () => {
      const candles = generateCandles(500);
      mockGetCandles.mockResolvedValue(candles);
      mockFetchKlines.mockResolvedValue(candles);
      mockFetchFearAndGreed.mockResolvedValue({
        fearGreedIndex: 45,
        label: 'Fear',
      });

      const { computeSignalBatch } = await import('./compute-engine');
      await computeSignalBatch([
        { symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'day_trading' },
        { symbol: 'ETHUSDT', interval: '1h', tradingStyle: 'day_trading' },
      ]);

      // Sentiment fetched exactly once
      expect(mockFetchFearAndGreed).toHaveBeenCalledTimes(1);
    });

    it('adjusts computed/errors count when individual inserts fail after bulk failure', async () => {
      const candles = generateCandles(500);
      mockGetCandles.mockResolvedValue(candles);
      mockFetchKlines.mockResolvedValue(candles);
      mockInsertMany.mockRejectedValue(new Error('Bulk write error'));
      mockCreate.mockRejectedValue(new Error('Individual insert error'));

      const { computeSignalBatch } = await import('./compute-engine');
      const result = await computeSignalBatch([
        { symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'day_trading' },
      ]);

      // computed should be decremented and errors incremented for failed individual inserts
      expect(result.computed).toBe(0);
      expect(result.errors).toBe(1);
    });
  });

  describe('buildTasksForStyle', () => {
    it('builds tasks for all preferred intervals', async () => {
      const { buildTasksForStyle } = await import('./compute-engine');
      const tasks = buildTasksForStyle('scalping', ['BTCUSDT', 'ETHUSDT']);

      // Scalping has 2 preferred intervals (1m, 5m), 2 symbols = 4 tasks
      expect(tasks).toHaveLength(4);
      expect(tasks).toContainEqual({
        symbol: 'BTCUSDT',
        interval: '1m',
        tradingStyle: 'scalping',
      });
      expect(tasks).toContainEqual({
        symbol: 'ETHUSDT',
        interval: '5m',
        tradingStyle: 'scalping',
      });
    });

    it('builds tasks for position_trading with single interval', async () => {
      const { buildTasksForStyle } = await import('./compute-engine');
      const tasks = buildTasksForStyle('position_trading', ['BTCUSDT']);

      // Position trading has 1 preferred interval (1d)
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toEqual({
        symbol: 'BTCUSDT',
        interval: '1d',
        tradingStyle: 'position_trading',
      });
    });

    it('builds tasks for day_trading', async () => {
      const { buildTasksForStyle } = await import('./compute-engine');
      const tasks = buildTasksForStyle('day_trading', ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);

      // Day trading has 2 preferred intervals (15m, 1h), 3 symbols = 6 tasks
      expect(tasks).toHaveLength(6);
    });
  });
});
