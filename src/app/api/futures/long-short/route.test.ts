// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/binance-futures', () => ({
  fetchLongShortRatio: vi.fn(),
  fetchGlobalLongShortRatio: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { cachedFetch } from '@/lib/redis';

const mockSession = { user: { id: 'user-1' } };

function makeRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/futures/long-short');
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

describe('GET /api/futures/long-short', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when symbol missing', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it('returns long/short ratio data', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockData = [
      { symbol: 'BTCUSDT', longShortRatio: 1.23, longAccount: 0.55, shortAccount: 0.45, timestamp: 1700000000000 },
    ];
    vi.mocked(cachedFetch).mockResolvedValue(mockData);

    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.longShortRatio).toEqual(mockData);
  });

  it('defaults to top traders ratio', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(cachedFetch).mockResolvedValue([]);

    await GET(makeRequest({ symbol: 'BTCUSDT' }));

    expect(cachedFetch).toHaveBeenCalledWith(
      'futures:ls:top:BTCUSDT:1h:30',
      expect.any(Function),
      300
    );
  });

  it('supports global ratio type', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(cachedFetch).mockResolvedValue([]);

    await GET(makeRequest({ symbol: 'BTCUSDT', type: 'global' }));

    expect(cachedFetch).toHaveBeenCalledWith(
      'futures:ls:global:BTCUSDT:1h:30',
      expect.any(Function),
      300
    );
  });

  it('passes period and limit parameters', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(cachedFetch).mockResolvedValue([]);

    await GET(makeRequest({ symbol: 'ETHUSDT', period: '4h', limit: '10' }));

    expect(cachedFetch).toHaveBeenCalledWith(
      'futures:ls:top:ETHUSDT:4h:10',
      expect.any(Function),
      300
    );
  });

  it('caps limit at 500', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(cachedFetch).mockResolvedValue([]);

    await GET(makeRequest({ symbol: 'BTCUSDT', limit: '1000' }));

    expect(cachedFetch).toHaveBeenCalledWith(
      'futures:ls:top:BTCUSDT:1h:500',
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
