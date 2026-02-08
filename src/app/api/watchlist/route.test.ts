// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/watchlist', () => ({
  Watchlist: {
    findOne: vi.fn(),
    create: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

import { GET, PUT } from './route';
import { auth } from '@/lib/auth';
import { Watchlist } from '@/lib/models/watchlist';

function makeRequest(body?: unknown, method = 'PUT'): NextRequest {
  if (body === undefined) {
    return new NextRequest('http://localhost/api/watchlist', { method });
  }
  return new NextRequest('http://localhost/api/watchlist', {
    method,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/watchlist', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET();
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns existing watchlist symbols', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: 'user-1' },
    } as never);
    vi.mocked(Watchlist.findOne).mockResolvedValue({
      symbols: ['BTCUSDT', 'ETHUSDT'],
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('creates default watchlist when none exists', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: 'user-1' },
    } as never);
    vi.mocked(Watchlist.findOne).mockResolvedValue(null);
    vi.mocked(Watchlist.create).mockResolvedValue({
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    } as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(Watchlist.create).toHaveBeenCalledWith({ userId: 'user-1' });
  });
});

describe('PUT /api/watchlist', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest({ symbols: ['BTCUSDT'] });
    const res = await PUT(req);
    expect(res.status).toBe(401);
  });

  it('accepts empty symbols array (clears watchlist)', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: 'user-1' },
    } as never);
    vi.mocked(Watchlist.findOneAndUpdate).mockResolvedValue({
      symbols: [],
    });

    const req = makeRequest({ symbols: [] });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.symbols).toEqual([]);
  });

  it('returns 400 for non-string items', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: 'user-1' },
    } as never);

    const req = makeRequest({ symbols: [123, null] });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty string items', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: 'user-1' },
    } as never);

    const req = makeRequest({ symbols: [''] });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when exceeding 50 symbols', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: 'user-1' },
    } as never);

    const symbols = Array.from({ length: 51 }, (_, i) => `SYM${i}USDT`);
    const req = makeRequest({ symbols });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing symbols field', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: 'user-1' },
    } as never);

    const req = makeRequest({ foo: 'bar' });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it('updates symbols and returns updated list', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: 'user-1' },
    } as never);
    vi.mocked(Watchlist.findOneAndUpdate).mockResolvedValue({
      symbols: ['DOGEUSDT', 'XRPUSDT'],
    });

    const req = makeRequest({ symbols: ['DOGEUSDT', 'XRPUSDT'] });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.symbols).toEqual(['DOGEUSDT', 'XRPUSDT']);
    expect(Watchlist.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { symbols: ['DOGEUSDT', 'XRPUSDT'] },
      { new: true, upsert: true }
    );
  });
});
