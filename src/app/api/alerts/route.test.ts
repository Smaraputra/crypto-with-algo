// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/alert', () => ({
  Alert: {
    find: vi.fn(),
    countDocuments: vi.fn(),
    create: vi.fn(),
  },
}));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { Alert } from '@/lib/models/alert';

function makeGetRequest(status?: string): NextRequest {
  const url = status
    ? `http://localhost/api/alerts?status=${status}`
    : 'http://localhost/api/alerts';
  return new NextRequest(url, { method: 'GET' });
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/alerts', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const mockSession = { user: { id: 'user-1' } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/alerts', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('returns all alerts for user', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.find).mockReturnValue({
      sort: vi.fn().mockResolvedValue([
        { _id: 'a1', type: 'price_above', symbol: 'BTCUSDT', status: 'active' },
        { _id: 'a2', type: 'price_below', symbol: 'ETHUSDT', status: 'triggered' },
      ]),
    } as never);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.alerts).toHaveLength(2);
    expect(Alert.find).toHaveBeenCalledWith({ userId: 'user-1' });
  });

  it('filters by status query param', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.find).mockReturnValue({
      sort: vi.fn().mockResolvedValue([
        { _id: 'a1', type: 'price_above', symbol: 'BTCUSDT', status: 'active' },
      ]),
    } as never);

    const res = await GET(makeGetRequest('active'));
    expect(res.status).toBe(200);
    expect(Alert.find).toHaveBeenCalledWith({ userId: 'user-1', status: 'active' });
  });

  it('ignores invalid status filter', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.find).mockReturnValue({
      sort: vi.fn().mockResolvedValue([]),
    } as never);

    const res = await GET(makeGetRequest('invalid'));
    expect(res.status).toBe(200);
    expect(Alert.find).toHaveBeenCalledWith({ userId: 'user-1' });
  });
});

describe('POST /api/alerts', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await POST(
      makePostRequest({ type: 'price_above', symbol: 'BTCUSDT', targetPrice: 100000 })
    );
    expect(res.status).toBe(401);
  });

  it('creates a price_above alert', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.countDocuments).mockResolvedValue(0);
    vi.mocked(Alert.create).mockResolvedValue({
      _id: 'a1',
      userId: 'user-1',
      symbol: 'BTCUSDT',
      type: 'price_above',
      targetPrice: 100000,
      status: 'active',
    } as never);

    const res = await POST(
      makePostRequest({ type: 'price_above', symbol: 'BTCUSDT', targetPrice: 100000 })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.alert.type).toBe('price_above');
    expect(data.alert.symbol).toBe('BTCUSDT');
  });

  it('creates a price_change_pct alert', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.countDocuments).mockResolvedValue(0);
    vi.mocked(Alert.create).mockResolvedValue({
      _id: 'a1',
      type: 'price_change_pct',
      symbol: 'BTCUSDT',
      percentChange: 5,
      referencePrice: 95000,
    } as never);

    const res = await POST(
      makePostRequest({
        type: 'price_change_pct',
        symbol: 'BTCUSDT',
        percentChange: 5,
        referencePrice: 95000,
      })
    );
    expect(res.status).toBe(201);
  });

  it('creates a portfolio_value_above alert', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.countDocuments).mockResolvedValue(0);
    vi.mocked(Alert.create).mockResolvedValue({
      _id: 'a1',
      type: 'portfolio_value_above',
      portfolioId: 'p1',
      targetPrice: 50000,
    } as never);

    const res = await POST(
      makePostRequest({
        type: 'portfolio_value_above',
        portfolioId: 'p1',
        targetPrice: 50000,
      })
    );
    expect(res.status).toBe(201);
  });

  it('creates a holding_change_pct alert', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.countDocuments).mockResolvedValue(0);
    vi.mocked(Alert.create).mockResolvedValue({
      _id: 'a1',
      type: 'holding_change_pct',
      portfolioId: 'p1',
      symbol: 'BTCUSDT',
      percentChange: -10,
    } as never);

    const res = await POST(
      makePostRequest({
        type: 'holding_change_pct',
        portfolioId: 'p1',
        symbol: 'BTCUSDT',
        percentChange: -10,
      })
    );
    expect(res.status).toBe(201);
  });

  it('returns 400 for missing symbol on price alert', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const res = await POST(
      makePostRequest({ type: 'price_above', targetPrice: 100000 })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Symbol is required');
  });

  it('returns 400 for missing targetPrice on price_below', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const res = await POST(
      makePostRequest({ type: 'price_below', symbol: 'BTCUSDT' })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Target price is required');
  });

  it('returns 400 for missing percentChange on price_change_pct', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const res = await POST(
      makePostRequest({ type: 'price_change_pct', symbol: 'BTCUSDT' })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Percent change is required');
  });

  it('returns 400 for missing portfolioId on portfolio_value_above', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const res = await POST(
      makePostRequest({ type: 'portfolio_value_above', targetPrice: 50000 })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Portfolio ID is required');
  });

  it('returns 400 for holding_change_pct without all required fields', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const res = await POST(
      makePostRequest({ type: 'holding_change_pct', portfolioId: 'p1' })
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid alert type', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const res = await POST(
      makePostRequest({ type: 'invalid_type', symbol: 'BTCUSDT' })
    );
    expect(res.status).toBe(400);
  });

  it('enforces 50-alert limit per user', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.countDocuments).mockResolvedValue(50);

    const res = await POST(
      makePostRequest({ type: 'price_above', symbol: 'BTCUSDT', targetPrice: 100000 })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Maximum of 50 alerts');
  });
});
