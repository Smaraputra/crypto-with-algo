import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockAuth = vi.fn();
const mockFindOne = vi.fn();
const mockConnectDB = vi.fn();

vi.mock('@/lib/auth', () => ({
  auth: () => mockAuth(),
}));

vi.mock('@/lib/models/global-signal', () => ({
  GlobalSignal: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: () => mockConnectDB(),
}));

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/signals/latest');
  for (const [key, val] of Object.entries(params)) {
    url.searchParams.set(key, val);
  }
  return new NextRequest(url);
}

describe('GET /api/signals/latest', () => {
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

  it('returns single signal for specific style', async () => {
    const mockSignal = { symbol: 'BTCUSDT', tradingStyle: 'scalping', score: 55 };
    mockFindOne.mockReturnValue({
      sort: () => ({
        lean: () => Promise.resolve(mockSignal),
      }),
    });

    const { GET } = await import('./route');
    const res = await GET(makeRequest({ symbol: 'BTCUSDT', tradingStyle: 'scalping' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.signal).toEqual(mockSignal);
  });

  it('filters by interval when provided', async () => {
    const mockSignal = { symbol: 'BTCUSDT', tradingStyle: 'day_trading', interval: '1h', score: 42 };
    mockFindOne.mockReturnValue({
      sort: () => ({
        lean: () => Promise.resolve(mockSignal),
      }),
    });

    const { GET } = await import('./route');
    const res = await GET(makeRequest({ symbol: 'BTCUSDT', tradingStyle: 'day_trading', interval: '1h' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.signal).toEqual(mockSignal);
    expect(mockFindOne).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      tradingStyle: 'day_trading',
      interval: '1h',
    });
  });

  it('returns latest signal for all 4 styles when no style specified', async () => {
    const signals: Record<string, unknown> = {
      scalping: { score: 55 },
      day_trading: { score: 45 },
      swing_trading: null,
      position_trading: { score: 30 },
    };

    mockFindOne.mockImplementation((query: { tradingStyle: string }) => ({
      sort: () => ({
        lean: () => Promise.resolve(signals[query.tradingStyle]),
      }),
    }));

    const { GET } = await import('./route');
    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.signals.scalping).toEqual({ score: 55 });
    expect(data.signals.day_trading).toEqual({ score: 45 });
    expect(data.signals.swing_trading).toBeNull();
    expect(data.signals.position_trading).toEqual({ score: 30 });
  });

  it('returns null for styles with no signals', async () => {
    mockFindOne.mockReturnValue({
      sort: () => ({
        lean: () => Promise.resolve(null),
      }),
    });

    const { GET } = await import('./route');
    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    const data = await res.json();

    expect(data.signals.scalping).toBeNull();
    expect(data.signals.day_trading).toBeNull();
  });
});
