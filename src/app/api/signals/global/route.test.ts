import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockAuth = vi.fn();
const mockFind = vi.fn();
const mockConnectDB = vi.fn();

vi.mock('@/lib/auth', () => ({
  auth: () => mockAuth(),
}));

vi.mock('@/lib/models/global-signal', () => ({
  GlobalSignal: {
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: () => mockConnectDB(),
}));

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/signals/global');
  for (const [key, val] of Object.entries(params)) {
    url.searchParams.set(key, val);
  }
  return new NextRequest(url);
}

describe('GET /api/signals/global', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'user1' } });
    mockConnectDB.mockResolvedValue(undefined);
  });

  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const { GET } = await import('./route');
    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when symbol is missing', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid trading style', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest({ symbol: 'BTCUSDT', tradingStyle: 'invalid' }));
    expect(res.status).toBe(400);
  });

  it('queries global signals by symbol', async () => {
    const mockSignals = [{ symbol: 'BTCUSDT', score: 45 }];
    mockFind.mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: () => Promise.resolve(mockSignals),
        }),
      }),
    });

    const { GET } = await import('./route');
    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.signals).toEqual(mockSignals);
    expect(mockFind).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
  });

  it('filters by tradingStyle when provided', async () => {
    mockFind.mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: () => Promise.resolve([]),
        }),
      }),
    });

    const { GET } = await import('./route');
    await GET(makeRequest({ symbol: 'BTCUSDT', tradingStyle: 'scalping' }));

    expect(mockFind).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      tradingStyle: 'scalping',
    });
  });

  it('filters by interval when provided', async () => {
    mockFind.mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: () => Promise.resolve([]),
        }),
      }),
    });

    const { GET } = await import('./route');
    await GET(makeRequest({ symbol: 'BTCUSDT', interval: '1h' }));

    expect(mockFind).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      interval: '1h',
    });
  });

  it('respects limit parameter capped at 200', async () => {
    const mockSort = vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        lean: () => Promise.resolve([]),
      }),
    });
    mockFind.mockReturnValue({ sort: mockSort });

    const { GET } = await import('./route');
    await GET(makeRequest({ symbol: 'BTCUSDT', limit: '500' }));

    const limitCall = mockSort.mock.results[0].value.limit;
    expect(limitCall).toHaveBeenCalledWith(200);
  });
});
