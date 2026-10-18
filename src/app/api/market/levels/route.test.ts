// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OHLCV } from '@/types/market';
import { DAY_MS } from '@/lib/market/levels';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
}));

vi.mock('@/lib/binance', () => ({
  fetchKlines: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: vi.fn(() => 'mock-limiter'),
  rateLimit: vi.fn(() => null),
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { cachedFetch } from '@/lib/redis';

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/market/levels');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

const mockSession = { user: { id: 'user-1' } };

function generateValidDailyCandles(nowMs: number): OHLCV[] {
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const candles: OHLCV[] = [];
  // 20 completed daily candles + 1 forming candle
  for (let i = 20; i >= 0; i--) {
    candles.push({
      timestamp: todayStart - i * DAY_MS,
      open: 100,
      high: 110,
      low: 90,
      close: 100,
      volume: 1000,
    });
  }
  return candles;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue(mockSession as never);
});

describe('GET /api/market/levels', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest({ symbols: 'BTCUSDT' }));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 for symbols=btcusdt (lowercase)', async () => {
    const res = await GET(makeRequest({ symbols: 'btcusdt' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 for empty symbols=', async () => {
    const res = await GET(makeRequest({ symbols: '' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 for 21 symbols', async () => {
    const symbols21 = Array.from({ length: 21 }, (_, i) => `COIN${i}USDT`).join(',');
    const res = await GET(makeRequest({ symbols: symbols21 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 200 with levels[sym] === null when one symbol fetch rejects while the other is computed', async () => {
    const mockCandles = generateValidDailyCandles(Date.now());
    vi.mocked(cachedFetch).mockImplementation(async (key: string) => {
      if (key.includes('FAILUSDT')) {
        throw new Error('Binance upstream failure');
      }
      return mockCandles;
    });

    const res = await GET(makeRequest({ symbols: 'BTCUSDT,FAILUSDT' }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.asOf).toBeDefined();
    expect(data.levels).toBeDefined();
    expect(data.levels.FAILUSDT).toBeNull();
    expect(data.levels.BTCUSDT).not.toBeNull();
    expect(data.levels.BTCUSDT.atr).toBe(20);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60');
  });

  it('uses cache keys starting with levels:1d:', async () => {
    const mockCandles = generateValidDailyCandles(Date.now());
    vi.mocked(cachedFetch).mockResolvedValue(mockCandles);

    const res = await GET(makeRequest({ symbols: 'BTCUSDT,ETHUSDT' }));
    expect(res.status).toBe(200);

    expect(cachedFetch).toHaveBeenCalledWith(
      'levels:1d:BTCUSDT',
      expect.any(Function),
      600
    );
    expect(cachedFetch).toHaveBeenCalledWith(
      'levels:1d:ETHUSDT',
      expect.any(Function),
      600
    );

    const calls = vi.mocked(cachedFetch).mock.calls;
    for (const call of calls) {
      expect(call[0]).toMatch(/^levels:1d:/);
      expect(call[0]).not.toMatch(/^klines:/);
      expect(call[0]).not.toMatch(/^prices:klines:/);
    }
  });
});
