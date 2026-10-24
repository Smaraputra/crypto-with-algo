// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OHLCV } from '@/types/market';

vi.mock('@/lib/binance', () => ({
  fetchKlines: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: vi.fn(() => 'mock-limiter'),
  rateLimit: vi.fn(() => null),
}));

import { GET } from './route';
import { fetchKlines } from '@/lib/binance';
import { cachedFetch } from '@/lib/redis';
import { rateLimit } from '@/lib/rate-limit';

function makeRequest(params?: string): NextRequest {
  const url = params
    ? `http://localhost/api/public/candles?${params}`
    : 'http://localhost/api/public/candles';
  return new NextRequest(url);
}

const mockKlines: OHLCV[] = [
  { timestamp: 1000, open: 65000, high: 65500, low: 64800, close: 65200, volume: 120 },
  { timestamp: 2000, open: 65200, high: 65800, low: 65100, close: 65600, volume: 150 },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockResolvedValue(null);
});

describe('GET /api/public/candles', () => {
  it('valid query returns mapped numbers in order with cache header', async () => {
    vi.mocked(cachedFetch).mockImplementation(async (_key, fn) => {
      vi.mocked(fetchKlines).mockResolvedValue(mockKlines);
      return fn();
    });

    const res = await GET(makeRequest('symbol=BTCUSDT&interval=1h&limit=48'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=120'
    );

    const data = await res.json();
    expect(data).toEqual([
      { t: 1000, o: 65000, h: 65500, l: 64800, c: 65200, v: 120 },
      { t: 2000, o: 65200, h: 65800, l: 65100, c: 65600, v: 150 },
    ]);
  });

  it('returns 400 for bad symbol', async () => {
    const res = await GET(makeRequest('symbol=DOGEUSDT&interval=1h&limit=48'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Unsupported symbol');
  });

  it('returns 400 for bad interval', async () => {
    const res = await GET(makeRequest('symbol=BTCUSDT&interval=4h&limit=48'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Unsupported interval');
  });

  it('returns 400 for bad limit values', async () => {
    const invalidLimits = ['0', '-5', '201', 'abc', '10.5'];
    for (const lim of invalidLimits) {
      const res = await GET(makeRequest(`symbol=BTCUSDT&interval=1h&limit=${lim}`));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('Invalid limit');
    }
  });

  it('limit defaults to 48 when omitted', async () => {
    vi.mocked(cachedFetch).mockResolvedValue([]);

    const res = await GET(makeRequest('symbol=ETHUSDT&interval=1h'));
    expect(res.status).toBe(200);
    expect(cachedFetch).toHaveBeenCalledWith(
      'public-candles:ETHUSDT:1h:48',
      expect.any(Function),
      60
    );
  });

  it('the cache key includes symbol, interval and limit', async () => {
    vi.mocked(cachedFetch).mockResolvedValue([]);

    const res = await GET(makeRequest('symbol=BTCUSDT&interval=1h&limit=100'));
    expect(res.status).toBe(200);
    expect(cachedFetch).toHaveBeenCalledWith(
      'public-candles:BTCUSDT:1h:100',
      expect.any(Function),
      60
    );
  });

  it('the rate-limit response is returned when limited', async () => {
    const { NextResponse } = await import('next/server');
    vi.mocked(rateLimit).mockResolvedValue(
      NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    );

    const res = await GET(makeRequest('symbol=BTCUSDT&interval=1h'));
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe('Too many requests');
  });

  it('an upstream throw gives 502 with error message', async () => {
    vi.mocked(cachedFetch).mockRejectedValue(new Error('Binance timeout'));

    const res = await GET(makeRequest('symbol=BTCUSDT&interval=1h'));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toBe('Market data is unavailable');
  });
});
