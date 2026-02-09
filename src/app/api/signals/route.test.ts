// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

const mockSignals = [
  { _id: 's1', symbol: 'BTCUSDT', tier: 'buy', score: 45 },
  { _id: 's2', symbol: 'ETHUSDT', tier: 'neutral', score: 10 },
];

const mockFind = vi.fn().mockReturnValue({
  sort: vi.fn().mockReturnValue({
    limit: vi.fn().mockResolvedValue(mockSignals),
  }),
});

vi.mock('@/lib/models/signal', () => ({
  Signal: { find: (...args: unknown[]) => mockFind(...args) },
}));

import { GET } from './route';
import { auth } from '@/lib/auth';

const mockSession = { user: { id: 'user-1' } };

function makeRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/signals');
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockReturnValue({
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(mockSignals),
    }),
  });
});

describe('GET /api/signals', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns signals for authenticated user', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.signals).toEqual(mockSignals);
  });

  it('filters by symbol', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    await GET(makeRequest({ symbol: 'BTCUSDT' }));

    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'BTCUSDT' })
    );
  });

  it('filters by tier', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    await GET(makeRequest({ tier: 'buy' }));

    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'buy' })
    );
  });

  it('ignores invalid tier', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    await GET(makeRequest({ tier: 'invalid' }));

    expect(mockFind).toHaveBeenCalledWith(
      expect.not.objectContaining({ tier: 'invalid' })
    );
  });

  it('respects limit parameter', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const sortMock = vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue([]),
    });
    mockFind.mockReturnValue({ sort: sortMock });

    await GET(makeRequest({ limit: '10' }));

    const limitCall = sortMock.mock.results[0].value.limit;
    expect(limitCall).toHaveBeenCalledWith(10);
  });

  it('caps limit at 200', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const limitMock = vi.fn().mockResolvedValue([]);
    const sortMock = vi.fn().mockReturnValue({ limit: limitMock });
    mockFind.mockReturnValue({ sort: sortMock });

    await GET(makeRequest({ limit: '500' }));

    expect(limitMock).toHaveBeenCalledWith(200);
  });
});
