// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
}));

vi.mock('@/lib/binance', () => ({
  fetchSymbols: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: vi.fn(() => 'mock-limiter'),
  rateLimit: vi.fn(() => null),
}));

import { GET } from './route';
import { cachedFetch } from '@/lib/redis';
import { rateLimit } from '@/lib/rate-limit';

const mockSymbols = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
];

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/symbols');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockResolvedValue(null);
});

describe('GET /api/symbols', () => {
  it('returns symbols from cache', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockSymbols);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual(mockSymbols);
  });

  it('uses 1 hour TTL for cache', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockSymbols);

    await GET(makeRequest());

    expect(cachedFetch).toHaveBeenCalledWith(
      'symbols:usdt',
      expect.any(Function),
      3600
    );
  });

  it('returns 500 when upstream fails', async () => {
    vi.mocked(cachedFetch).mockRejectedValue(new Error('Binance down'));

    const res = await GET(makeRequest());
    expect(res.status).toBe(500);

    const data = await res.json();
    expect(data.error).toBe('Failed to fetch symbols');
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
