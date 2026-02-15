// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OHLCV } from '@/types/market';

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

const mockKlines: OHLCV[] = [
  { timestamp: 1700000000000, open: 50000, high: 51000, low: 49000, close: 50500, volume: 100 },
  { timestamp: 1700003600000, open: 50500, high: 52000, low: 50000, close: 51500, volume: 120 },
];

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/prices/history');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

const mockSession = { user: { id: 'user-1' } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue(mockSession as never);
});

describe('GET /api/prices/history', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest({ symbol: 'BTCUSDT', interval: '1h' }));
    expect(res.status).toBe(401);
  });

  it('returns OHLCV data for valid params', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockKlines);

    const res = await GET(makeRequest({ symbol: 'BTCUSDT', interval: '1h' }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual(mockKlines);
  });

  it('includes Cache-Control header matching interval TTL', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockKlines);

    const res = await GET(makeRequest({ symbol: 'BTCUSDT', interval: '1h' }));
    // 1h TTL is 120, stale-while-revalidate is 240
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=120, stale-while-revalidate=240'
    );
  });

  it('uses short Cache-Control for 1m interval', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockKlines);

    const res = await GET(makeRequest({ symbol: 'BTCUSDT', interval: '1m' }));
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=10, stale-while-revalidate=20'
    );
  });

  it('returns 400 for missing symbol', async () => {
    const res = await GET(makeRequest({ interval: '1h' }));
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 for missing interval', async () => {
    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 for invalid interval', async () => {
    const res = await GET(makeRequest({ symbol: 'BTCUSDT', interval: '7m' }));
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 for limit below minimum', async () => {
    const res = await GET(makeRequest({ symbol: 'BTCUSDT', interval: '1h', limit: '0' }));
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 for limit above maximum', async () => {
    const res = await GET(makeRequest({ symbol: 'BTCUSDT', interval: '1h', limit: '1001' }));
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('uses default limit of 500 when omitted', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockKlines);

    await GET(makeRequest({ symbol: 'BTCUSDT', interval: '1h' }));

    expect(cachedFetch).toHaveBeenCalledWith(
      'klines:BTCUSDT:1h:500',
      expect.any(Function),
      120
    );
  });

  it('uses TTL of 10s for 1m interval', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockKlines);

    await GET(makeRequest({ symbol: 'BTCUSDT', interval: '1m' }));

    expect(cachedFetch).toHaveBeenCalledWith(
      'klines:BTCUSDT:1m:500',
      expect.any(Function),
      10
    );
  });

  it('uses TTL of 600s for 1d interval', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockKlines);

    await GET(makeRequest({ symbol: 'BTCUSDT', interval: '1d' }));

    expect(cachedFetch).toHaveBeenCalledWith(
      'klines:BTCUSDT:1d:500',
      expect.any(Function),
      600
    );
  });

  it('includes custom limit in cache key', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockKlines);

    await GET(makeRequest({ symbol: 'ETHUSDT', interval: '4h', limit: '100' }));

    expect(cachedFetch).toHaveBeenCalledWith(
      'klines:ETHUSDT:4h:100',
      expect.any(Function),
      300
    );
  });

  it('returns 500 when upstream fails', async () => {
    vi.mocked(cachedFetch).mockRejectedValue(new Error('Binance down'));

    const res = await GET(makeRequest({ symbol: 'BTCUSDT', interval: '1h' }));
    expect(res.status).toBe(500);

    const data = await res.json();
    expect(data.error).toBe('Failed to fetch price history');
  });

  describe('new intervals', () => {
    it.each([
      ['3m', 15],
      ['30m', 60],
      ['2h', 180],
      ['6h', 300],
      ['12h', 600],
      ['1w', 1800],
      ['1M', 3600],
    ])('accepts %s interval with TTL %d', async (interval, expectedTtl) => {
      vi.mocked(cachedFetch).mockResolvedValue(mockKlines);

      const res = await GET(makeRequest({ symbol: 'BTCUSDT', interval }));
      expect(res.status).toBe(200);

      expect(cachedFetch).toHaveBeenCalledWith(
        `klines:BTCUSDT:${interval}:500`,
        expect.any(Function),
        expectedTtl
      );
    });
  });

  describe('time range parameters', () => {
    it('passes startTime and endTime to fetchKlines', async () => {
      vi.mocked(cachedFetch).mockResolvedValue(mockKlines);

      await GET(makeRequest({
        symbol: 'BTCUSDT',
        interval: '1h',
        startTime: '1700000000000',
        endTime: '1700100000000',
      }));

      // Cache key includes time range
      expect(cachedFetch).toHaveBeenCalledWith(
        'klines:BTCUSDT:1h:500:1700000000000:1700100000000',
        expect.any(Function),
        120
      );
    });

    it('passes only startTime when endTime is omitted', async () => {
      vi.mocked(cachedFetch).mockResolvedValue(mockKlines);

      await GET(makeRequest({
        symbol: 'BTCUSDT',
        interval: '1h',
        startTime: '1700000000000',
      }));

      expect(cachedFetch).toHaveBeenCalledWith(
        'klines:BTCUSDT:1h:500:1700000000000:',
        expect.any(Function),
        120
      );
    });

    it('returns 400 for non-numeric startTime', async () => {
      const res = await GET(makeRequest({
        symbol: 'BTCUSDT',
        interval: '1h',
        startTime: 'abc',
      }));
      expect(res.status).toBe(400);
    });

    it('returns 400 for negative startTime', async () => {
      const res = await GET(makeRequest({
        symbol: 'BTCUSDT',
        interval: '1h',
        startTime: '-1',
      }));
      expect(res.status).toBe(400);
    });
  });
});
