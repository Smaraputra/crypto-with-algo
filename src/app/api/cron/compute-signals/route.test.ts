// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OHLCV } from '@/types/market';

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
}));

vi.mock('@/lib/binance', () => ({
  fetchKlines: vi.fn(),
}));

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

vi.mock('@/lib/models/strategy', () => ({
  Strategy: {
    find: vi.fn(),
  },
}));

const mockComputeSignalBatch = vi.fn();
const mockBuildTasksForStyle = vi.fn();

vi.mock('@/lib/signals/compute-engine', () => ({
  computeSignalBatch: (...args: unknown[]) => mockComputeSignalBatch(...args),
  buildTasksForStyle: (...args: unknown[]) => mockBuildTasksForStyle(...args),
}));

vi.mock('@/lib/signals/signal-symbols', () => ({
  SIGNAL_SYMBOLS: ['BTCUSDT', 'ETHUSDT'],
}));

// computeAllIndicators is real (candle-ingestion isn't mocked in this file
// either), wrapped only so tests can inspect what candles it was called with.
vi.mock('@/lib/indicators/compute', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/indicators/compute')>('@/lib/indicators/compute');
  return { ...actual, computeAllIndicators: vi.fn(actual.computeAllIndicators) };
});

import { GET } from './route';
import { cachedFetch } from '@/lib/redis';
import { Signal } from '@/lib/models/signal';
import { Strategy } from '@/lib/models/strategy';
import { computeAllIndicators } from '@/lib/indicators/compute';

// Fixed, controlled "now" for tests that care about the closed-bar boundary,
// same pattern as candle-ingestion.test.ts.
const NOW = 1_700_000_000_000;

function generateCandles(count: number): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 40000;
  const baseTime = Date.now() - count * 60 * 60 * 1000;

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

function makeRequest(secret?: string, params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/cron/compute-signals');
  if (params) {
    for (const [key, val] of Object.entries(params)) {
      url.searchParams.set(key, val);
    }
  }
  const headers: Record<string, string> = {};
  if (secret) headers.authorization = `Bearer ${secret}`;
  return new NextRequest(url, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', 'test-secret');
});

describe('GET /api/cron/compute-signals', () => {
  it('returns 401 without cron secret', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong secret', async () => {
    const res = await GET(makeRequest('wrong'));
    expect(res.status).toBe(401);
  });

  it('returns 0 computed when no active strategies', async () => {
    vi.mocked(Strategy.find).mockResolvedValue([]);
    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.computed).toBe(0);
  });

  it('computes signals for active strategies', async () => {
    vi.mocked(Strategy.find).mockResolvedValue([
      {
        userId: 'user-1',
        symbols: ['BTCUSDT'],
        intervals: ['1h'],
        weights: { trend: 0.25, momentum: 0.25, volume: 0.15, volatility: 0.10, futures: 0.15, sentiment: 0.10 },
        active: true,
      },
    ] as never);

    const candles = generateCandles(500);
    vi.mocked(cachedFetch)
      .mockResolvedValueOnce(candles)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.computed).toBe(1);
    expect(data.pairs).toBe(1);
    expect(Signal.create).toHaveBeenCalledTimes(1);
  });

  it('deduplicates symbol-interval pairs', async () => {
    vi.mocked(Strategy.find).mockResolvedValue([
      {
        userId: 'user-1',
        symbols: ['BTCUSDT'],
        intervals: ['1h'],
        weights: { trend: 0.25, momentum: 0.25, volume: 0.15, volatility: 0.10, futures: 0.15, sentiment: 0.10 },
        active: true,
      },
      {
        userId: 'user-2',
        symbols: ['BTCUSDT'],
        intervals: ['1h'],
        weights: { trend: 0.25, momentum: 0.25, volume: 0.15, volatility: 0.10, futures: 0.15, sentiment: 0.10 },
        active: true,
      },
    ] as never);

    const candles = generateCandles(500);
    vi.mocked(cachedFetch)
      .mockResolvedValueOnce(candles) // candles for BTCUSDT:1h (shared)
      .mockResolvedValueOnce([])     // funding rate
      .mockResolvedValueOnce([]);    // L/S ratio

    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);
    const data = await res.json();
    // 1 pair, but 2 users
    expect(data.pairs).toBe(1);
    expect(data.computed).toBe(2);
    expect(Signal.create).toHaveBeenCalledTimes(2);
  });

  it('handles errors gracefully', async () => {
    vi.mocked(Strategy.find).mockResolvedValue([
      {
        userId: 'user-1',
        symbols: ['BTCUSDT'],
        intervals: ['1h'],
        weights: { trend: 0.25, momentum: 0.25, volume: 0.15, volatility: 0.10, futures: 0.15, sentiment: 0.10 },
        active: true,
      },
    ] as never);

    vi.mocked(cachedFetch).mockRejectedValue(new Error('network error'));

    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.errors).toBe(1);
    expect(data.computed).toBe(0);
  });

  it('excludes an open trailing bar from what the legacy path scores', async () => {
    vi.mocked(Strategy.find).mockResolvedValue([
      {
        userId: 'user-1',
        symbols: ['BTCUSDT'],
        intervals: ['1h'],
        weights: { trend: 0.25, momentum: 0.25, volume: 0.15, volatility: 0.10, futures: 0.15, sentiment: 0.10 },
        active: true,
      },
    ] as never);

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

      const res = await GET(makeRequest('test-secret'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.computed).toBe(1);

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

  it('skips the pair with a log line when only an open candle is available', async () => {
    vi.mocked(Strategy.find).mockResolvedValue([
      {
        userId: 'user-1',
        symbols: ['BTCUSDT'],
        intervals: ['1h'],
        weights: { trend: 0.25, momentum: 0.25, volume: 0.15, volatility: 0.10, futures: 0.15, sentiment: 0.10 },
        active: true,
      },
    ] as never);

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

      const res = await GET(makeRequest('test-secret'));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.computed).toBe(0);
      expect(data.errors).toBe(0);
      expect(Signal.create).not.toHaveBeenCalled();
      expect(computeAllIndicators).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/no closed candle/i));
    } finally {
      logSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });
});

describe('GET /api/cron/compute-signals?style=', () => {
  it('returns 400 for invalid trading style', async () => {
    const res = await GET(makeRequest('test-secret', { style: 'invalid_style' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Invalid trading style');
  });

  it('calls computeSignalBatch for valid style', async () => {
    const mockTasks = [
      { symbol: 'BTCUSDT', interval: '15m', tradingStyle: 'day_trading' },
      { symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'day_trading' },
      { symbol: 'ETHUSDT', interval: '15m', tradingStyle: 'day_trading' },
      { symbol: 'ETHUSDT', interval: '1h', tradingStyle: 'day_trading' },
    ];
    mockBuildTasksForStyle.mockReturnValue(mockTasks);
    mockComputeSignalBatch.mockResolvedValue({
      computed: 4,
      errors: 0,
      skipped: 0,
      details: [],
    });

    const res = await GET(makeRequest('test-secret', { style: 'day_trading' }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.mode).toBe('global');
    expect(data.style).toBe('day_trading');
    expect(data.computed).toBe(4);
    expect(data.errors).toBe(0);
    expect(data.tasks).toBe(4);

    expect(mockBuildTasksForStyle).toHaveBeenCalledWith('day_trading', ['BTCUSDT', 'ETHUSDT']);
    expect(mockComputeSignalBatch).toHaveBeenCalledWith(mockTasks);
  });

  it('returns mode:global for scalping style', async () => {
    mockBuildTasksForStyle.mockReturnValue([]);
    mockComputeSignalBatch.mockResolvedValue({
      computed: 0,
      errors: 0,
      skipped: 0,
      details: [],
    });

    const res = await GET(makeRequest('test-secret', { style: 'scalping' }));
    const data = await res.json();
    expect(data.mode).toBe('global');
    expect(data.style).toBe('scalping');
  });

  it('returns mode:global for position_trading style', async () => {
    mockBuildTasksForStyle.mockReturnValue([
      { symbol: 'BTCUSDT', interval: '1d', tradingStyle: 'position_trading' },
    ]);
    mockComputeSignalBatch.mockResolvedValue({
      computed: 1,
      errors: 0,
      skipped: 0,
      details: [],
    });

    const res = await GET(makeRequest('test-secret', { style: 'position_trading' }));
    const data = await res.json();
    expect(data.mode).toBe('global');
    expect(data.style).toBe('position_trading');
    expect(data.computed).toBe(1);
  });

  it('reports errors from compute batch', async () => {
    mockBuildTasksForStyle.mockReturnValue([
      { symbol: 'BTCUSDT', interval: '1m', tradingStyle: 'scalping' },
    ]);
    mockComputeSignalBatch.mockResolvedValue({
      computed: 0,
      errors: 1,
      skipped: 0,
      details: [
        { symbol: 'BTCUSDT', interval: '1m', tradingStyle: 'scalping', status: 'error', error: 'API error' },
      ],
    });

    const res = await GET(makeRequest('test-secret', { style: 'scalping' }));
    const data = await res.json();
    expect(data.errors).toBe(1);
    expect(data.computed).toBe(0);
  });

  it('does not run legacy computation when style param is present', async () => {
    mockBuildTasksForStyle.mockReturnValue([]);
    mockComputeSignalBatch.mockResolvedValue({
      computed: 0, errors: 0, skipped: 0, details: [],
    });

    await GET(makeRequest('test-secret', { style: 'swing_trading' }));

    // Legacy path uses Strategy.find -- should NOT be called
    expect(Strategy.find).not.toHaveBeenCalled();
    expect(Signal.create).not.toHaveBeenCalled();
  });

  it('legacy path runs when no style param', async () => {
    vi.mocked(Strategy.find).mockResolvedValue([]);

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.mode).toBe('legacy');

    expect(Strategy.find).toHaveBeenCalledTimes(1);
    expect(mockBuildTasksForStyle).not.toHaveBeenCalled();
  });
});
