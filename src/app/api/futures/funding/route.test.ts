// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/binance-futures', () => ({
  fetchFundingRate: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { cachedFetch } from '@/lib/redis';

const mockSession = { user: { id: 'user-1' } };

function makeRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/futures/funding');
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/futures/funding', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when symbol missing', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('symbol');
  });

  it('returns funding rates on success', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockData = [
      { symbol: 'BTCUSDT', fundingRate: 0.0001, fundingTime: 1700000000000, markPrice: 43000 },
    ];
    vi.mocked(cachedFetch).mockResolvedValue(mockData);

    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.fundingRates).toEqual(mockData);
  });

  it('uses Redis cache with 300s TTL', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(cachedFetch).mockResolvedValue([]);

    await GET(makeRequest({ symbol: 'BTCUSDT' }));

    expect(cachedFetch).toHaveBeenCalledWith(
      'futures:funding:BTCUSDT:1',
      expect.any(Function),
      300
    );
  });

  it('passes limit parameter', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(cachedFetch).mockResolvedValue([]);

    await GET(makeRequest({ symbol: 'BTCUSDT', limit: '5' }));

    expect(cachedFetch).toHaveBeenCalledWith(
      'futures:funding:BTCUSDT:5',
      expect.any(Function),
      300
    );
  });

  it('caps limit at 100', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(cachedFetch).mockResolvedValue([]);

    await GET(makeRequest({ symbol: 'BTCUSDT', limit: '500' }));

    expect(cachedFetch).toHaveBeenCalledWith(
      'futures:funding:BTCUSDT:100',
      expect.any(Function),
      300
    );
  });

  it('returns 502 on upstream error', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(cachedFetch).mockRejectedValue(new Error('HTTP 403'));

    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toContain('403');
  });
});
