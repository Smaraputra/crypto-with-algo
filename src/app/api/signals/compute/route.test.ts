// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OHLCV } from '@/types/market';

const mockComputeSignalBatch = vi.fn();
const mockGlobalSignalFindOne = vi.fn();

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
  ioRedisClient: null,
}));

vi.mock('@/lib/binance', () => ({
  fetchKlines: vi.fn(),
}));

const mockGetCandles = vi.fn();
// dropOpenBars is pure (no DB/IO), so keep the real implementation while
// getCandles stays fully mocked -- lets one test exercise the real
// cachedFetch producer (getCandles -> fetchKlines fallback -> dropOpenBars).
vi.mock('@/lib/candle-ingestion', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/candle-ingestion')>('@/lib/candle-ingestion');
  return {
    dropOpenBars: actual.dropOpenBars,
    getCandles: (...args: unknown[]) => mockGetCandles(...args),
  };
});

vi.mock('@/lib/binance-futures', () => ({
  fetchFundingRate: vi.fn(),
  fetchLongShortRatio: vi.fn(),
}));

vi.mock('@/lib/external/fear-greed', () => ({
  fetchFearAndGreed: vi.fn().mockResolvedValue({
    fearGreedIndex: 50,
    label: 'Neutral',
  }),
}));

vi.mock('@/lib/models/signal', () => ({
  Signal: {
    create: vi.fn().mockResolvedValue({ _id: 'signal-1' }),
  },
}));

vi.mock('@/lib/signals/compute-engine', () => ({
  computeSignalBatch: (...args: unknown[]) => mockComputeSignalBatch(...args),
}));

vi.mock('@/lib/models/global-signal', () => ({
  GlobalSignal: {
    findOne: (...args: unknown[]) => mockGlobalSignalFindOne(...args),
  },
}));

// computeAllIndicators is real, wrapped only so tests can inspect what
// candles it was called with (mirrors the cron compute-signals route test).
vi.mock('@/lib/indicators/compute', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/indicators/compute')>('@/lib/indicators/compute');
  return { ...actual, computeAllIndicators: vi.fn(actual.computeAllIndicators) };
});

import { POST } from './route';
import { auth } from '@/lib/auth';
import { cachedFetch } from '@/lib/redis';
import { fetchKlines } from '@/lib/binance';
import { computeAllIndicators } from '@/lib/indicators/compute';

const mockSession = { user: { id: 'user-1' } };

// Fixed, controlled "now" for tests that care about the closed-bar boundary.
const NOW = 1_700_000_000_000;

function generateCandles(count: number, now: number = Date.now()): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 40000;
  const baseTime = now - count * 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    const change = (Math.sin(i * 0.1) * 0.01 + 0.001) * price;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;

    candles.push({
      timestamp: baseTime + i * 60 * 60 * 1000,
      open, high, low, close,
      volume: 100 + Math.random() * 200,
    });
    price = close;
  }

  return candles;
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/signals/compute', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/signals/compute', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing symbol', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('computes signal successfully', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const candles = generateCandles(500);

    // cachedFetch: first call is candles, then funding rate in fetchFuturesDataSafe, then L/S ratio
    vi.mocked(cachedFetch)
      .mockResolvedValueOnce(candles)
      .mockResolvedValueOnce([{ symbol: 'BTCUSDT', fundingRate: 0.0001, fundingTime: 0, markPrice: 40000 }])
      .mockResolvedValueOnce([{ symbol: 'BTCUSDT', longShortRatio: 1.0, longAccount: 0.5, shortAccount: 0.5, timestamp: 0 }]);

    const res = await POST(makeRequest({ symbol: 'BTCUSDT', interval: '1h' }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.signal).toBeDefined();
    expect(data.signal.symbol).toBe('BTCUSDT');
    expect(data.signal.score).toBeDefined();
    expect(data.signal.tier).toBeDefined();
    expect(data.signal._id).toBe('signal-1');
  });

  it('handles upstream error gracefully', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(cachedFetch).mockRejectedValue(new Error('Binance down'));

    const res = await POST(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('Binance down');
  });

  it('defaults interval to 1h', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const candles = generateCandles(500);
    vi.mocked(cachedFetch)
      .mockResolvedValueOnce(candles)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await POST(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.signal.interval).toBe('1h');
  });

  it('excludes an open trailing bar from what the legacy path scores', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const closed = generateCandles(500); // last bar closes exactly at NOW
      // Still-forming bar: opened 30 minutes ago, not a full hour old yet.
      const openBar: OHLCV = { ...closed[closed.length - 1], timestamp: NOW - 30 * 60 * 1000 };
      const withOpenBar = [...closed, openBar];

      vi.mocked(cachedFetch)
        .mockResolvedValueOnce(withOpenBar)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const res = await POST(makeRequest({ symbol: 'BTCUSDT', interval: '1h' }));
      expect(res.status).toBe(200);

      const receivedCandles = vi.mocked(computeAllIndicators).mock.calls[0][0] as OHLCV[];
      expect(receivedCandles).toHaveLength(closed.length);
      expect(receivedCandles.map((c) => c.timestamp)).not.toContain(openBar.timestamp);
      expect(receivedCandles[receivedCandles.length - 1].timestamp).toBe(
        closed[closed.length - 1].timestamp
      );
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('returns 500 with a log line when only an open candle is available', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const openOnly: OHLCV[] = [
        { timestamp: NOW - 30 * 60 * 1000, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
      ];
      vi.mocked(cachedFetch)
        .mockResolvedValueOnce(openOnly)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const res = await POST(makeRequest({ symbol: 'BTCUSDT', interval: '1h' }));
      // Same status and error shape as the global branch's "produced no
      // result" response (below): both mean "nothing scoreable for this
      // request right now."
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toMatch(/no closed candle/i);
      expect(computeAllIndicators).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/no closed candle/i));
    } finally {
      logSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  it('returns 400 for an interval outside VALID_INTERVALS', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const res = await POST(makeRequest({ symbol: 'BTCUSDT', interval: '2h' }));
    expect(res.status).toBe(400);
  });

  it('caches the fetchKlines-fallback result already filtered, so a later cache read past the bar\'s close still excludes it', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    // T1: this request runs the fetchKlines fallback and populates the 60s
    // Redis cache. T2: a later, separate request whose own `now` is well
    // past the bar's close.
    const T1 = NOW;
    const T2 = NOW + 2 * 60 * 60 * 1000;

    const closed = generateCandles(500, T1);
    const openAtT1: OHLCV = { ...closed[closed.length - 1], timestamp: T1 - 30 * 60 * 1000 };

    // Mongo holds fewer than RECOMMENDED_CANDLES, so the cachedFetch
    // producer falls back to fetchKlines -- whose response ends with the
    // still-forming bar -- and must filter it before the value is cached.
    mockGetCandles.mockResolvedValue([]);
    vi.mocked(fetchKlines).mockResolvedValue([...closed, openAtT1]);

    // Real (unbounded, good enough for this test) in-memory cache so the
    // second POST below -- a separate request sharing the real 60s Redis
    // cache -- hits the exact entry the first request wrote, instead of
    // invoking the producer (and therefore fetchKlines) again.
    const cache = new Map<string, unknown>();
    vi.mocked(cachedFetch).mockImplementation(async (key: string, fn: () => Promise<unknown>) => {
      if (cache.has(key)) return cache.get(key);
      const value = await fn();
      cache.set(key, value);
      return value;
    });

    const dateSpy = vi.spyOn(Date, 'now');
    try {
      dateSpy.mockReturnValue(T1);
      const res1 = await POST(makeRequest({ symbol: 'BTCUSDT', interval: '1h' }));
      expect(res1.status).toBe(200);
      const firstCandles = vi.mocked(computeAllIndicators).mock.calls[0][0] as OHLCV[];
      expect(firstCandles.map((c) => c.timestamp)).not.toContain(openAtT1.timestamp);

      vi.mocked(computeAllIndicators).mockClear();
      dateSpy.mockReturnValue(T2); // a later request; wall-clock has moved on
      const res2 = await POST(makeRequest({ symbol: 'BTCUSDT', interval: '1h' }));
      expect(res2.status).toBe(200);

      // Cache hit: the producer (and fetchKlines) never runs again, so the
      // open bar can't leak back in just because T2's outer filter would
      // now call it "closed".
      expect(fetchKlines).toHaveBeenCalledTimes(1);
      const secondCandles = vi.mocked(computeAllIndicators).mock.calls[0][0] as OHLCV[];
      expect(secondCandles.map((c) => c.timestamp)).not.toContain(openAtT1.timestamp);
    } finally {
      dateSpy.mockRestore();
    }
  });
});

describe('POST /api/signals/compute (global signal path)', () => {
  const globalSignalDoc = {
    _id: 'gs-1',
    symbol: 'BTCUSDT',
    interval: '4h',
    tradingStyle: 'swing_trading',
    score: 72,
    tier: 'bullish',
    confidence: 0.8,
    components: [],
    configVersion: 1,
    candleTimestamp: Date.now(),
    expiresAt: new Date(Date.now() + 86400000),
    createdAt: new Date(),
  };

  it('uses computeSignalBatch when tradingStyle is provided', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockComputeSignalBatch.mockResolvedValue({ computed: 1, errors: 0, skipped: 0, details: [] });
    mockGlobalSignalFindOne.mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(globalSignalDoc) }),
    });

    const res = await POST(
      makeRequest({ symbol: 'BTCUSDT', interval: '4h', tradingStyle: 'swing_trading' })
    );
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.signal.symbol).toBe('BTCUSDT');
    expect(data.signal.tradingStyle).toBe('swing_trading');
    expect(data.signal.score).toBe(72);

    expect(mockComputeSignalBatch).toHaveBeenCalledWith([
      { symbol: 'BTCUSDT', interval: '4h', tradingStyle: 'swing_trading' },
    ]);
    expect(mockGlobalSignalFindOne).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      interval: '4h',
      tradingStyle: 'swing_trading',
    });
  });

  it('returns 500 when computeSignalBatch produces no result', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockComputeSignalBatch.mockResolvedValue({ computed: 0, errors: 1, skipped: 0, details: [] });
    mockGlobalSignalFindOne.mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    });

    const res = await POST(
      makeRequest({ symbol: 'BTCUSDT', interval: '4h', tradingStyle: 'swing_trading' })
    );
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('no result');
  });

  it('returns 400 for invalid tradingStyle', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const res = await POST(
      makeRequest({ symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'yolo_trading' })
    );
    expect(res.status).toBe(400);
  });

  it('does not call computeSignalBatch when tradingStyle is omitted', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const candles = generateCandles(500);
    vi.mocked(cachedFetch)
      .mockResolvedValueOnce(candles)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await POST(makeRequest({ symbol: 'BTCUSDT', interval: '1h' }));
    expect(res.status).toBe(200);
    expect(mockComputeSignalBatch).not.toHaveBeenCalled();
  });
});
