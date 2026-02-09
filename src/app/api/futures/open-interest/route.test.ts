// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/binance-futures', () => ({
  fetchOpenInterest: vi.fn(),
  fetchOpenInterestHistory: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { cachedFetch } from '@/lib/redis';

const mockSession = { user: { id: 'user-1' } };

function makeRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/futures/open-interest');
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

describe('GET /api/futures/open-interest', () => {
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

  it('returns current open interest', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockOI = { symbol: 'BTCUSDT', openInterest: 12345.678, time: 1700000000000 };
    vi.mocked(cachedFetch).mockResolvedValue(mockOI);

    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.openInterest).toEqual(mockOI);
    expect(data.history).toBeNull();
  });

  it('includes history when requested', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockOI = { symbol: 'BTCUSDT', openInterest: 12345, time: 1700000000000 };
    const mockHistory = [
      { symbol: 'BTCUSDT', sumOpenInterest: 12345, sumOpenInterestValue: 530000000, timestamp: 1700000000000 },
    ];
    vi.mocked(cachedFetch)
      .mockResolvedValueOnce(mockOI)
      .mockResolvedValueOnce(mockHistory);

    const res = await GET(makeRequest({ symbol: 'BTCUSDT', history: 'true' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.openInterest).toEqual(mockOI);
    expect(data.history).toEqual(mockHistory);
  });

  it('uses 60s TTL for current OI', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(cachedFetch).mockResolvedValue({ symbol: 'BTCUSDT', openInterest: 0, time: 0 });

    await GET(makeRequest({ symbol: 'BTCUSDT' }));

    expect(cachedFetch).toHaveBeenCalledWith(
      'futures:oi:BTCUSDT',
      expect.any(Function),
      60
    );
  });

  it('uses 300s TTL for history', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(cachedFetch)
      .mockResolvedValueOnce({ symbol: 'BTCUSDT', openInterest: 0, time: 0 })
      .mockResolvedValueOnce([]);

    await GET(makeRequest({ symbol: 'BTCUSDT', history: 'true', period: '1h' }));

    expect(cachedFetch).toHaveBeenCalledWith(
      'futures:oi-hist:BTCUSDT:1h:30',
      expect.any(Function),
      300
    );
  });

  it('returns 502 on upstream error', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(cachedFetch).mockRejectedValue(new Error('timeout'));

    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(502);
  });
});
