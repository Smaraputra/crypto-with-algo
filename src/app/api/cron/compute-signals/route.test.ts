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

import { GET } from './route';
import { cachedFetch } from '@/lib/redis';
import { Signal } from '@/lib/models/signal';
import { Strategy } from '@/lib/models/strategy';

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
