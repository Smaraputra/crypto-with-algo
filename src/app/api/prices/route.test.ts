// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Ticker24h } from '@/types/market';

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
}));

vi.mock('@/lib/binance', () => ({
  fetchTickers: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: vi.fn(() => 'mock-limiter'),
  rateLimit: vi.fn(() => null),
}));

import { GET } from './route';
import { cachedFetch } from '@/lib/redis';
import { rateLimit } from '@/lib/rate-limit';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/prices');
}

const mockTickers: Ticker24h[] = [
  {
    symbol: 'BTCUSDT',
    lastPrice: '50000',
    priceChange: '1000',
    priceChangePercent: '2.0',
    highPrice: '51000',
    lowPrice: '49000',
    volume: '1000',
    quoteVolume: '50000000',
    openPrice: '49000',
    count: 100000,
  },
  {
    symbol: 'ETHUSDT',
    lastPrice: '3000',
    priceChange: '50',
    priceChangePercent: '1.7',
    highPrice: '3100',
    lowPrice: '2900',
    volume: '5000',
    quoteVolume: '15000000',
    openPrice: '2950',
    count: 80000,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockResolvedValue(null);
});

describe('GET /api/prices', () => {
  it('returns filtered tickers on success', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockTickers);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual(mockTickers);
  });

  it('includes Cache-Control header', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockTickers);

    const res = await GET(makeRequest());
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=30, stale-while-revalidate=60'
    );
  });

  it('calls cachedFetch with correct key and TTL', async () => {
    vi.mocked(cachedFetch).mockResolvedValue([]);

    await GET(makeRequest());

    expect(cachedFetch).toHaveBeenCalledWith(
      'tickers:top',
      expect.any(Function),
      30
    );
  });

  it('returns 500 when upstream fails', async () => {
    vi.mocked(cachedFetch).mockRejectedValue(new Error('Binance down'));

    const res = await GET(makeRequest());
    expect(res.status).toBe(500);

    const data = await res.json();
    expect(data.error).toBe('Failed to fetch prices');
  });

  it('returns 429 when rate limited', async () => {
    const { NextResponse } = await import('next/server');
    vi.mocked(rateLimit).mockResolvedValue(
      NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    );

    const res = await GET(makeRequest());
    expect(res.status).toBe(429);
  });
});
