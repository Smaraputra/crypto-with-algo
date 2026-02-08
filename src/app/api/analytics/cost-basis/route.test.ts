// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/models/portfolio', () => ({
  Portfolio: { findOne: vi.fn() },
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { Portfolio } from '@/lib/models/portfolio';

const mockSession = { user: { id: 'user-1' } };

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost/api/analytics/cost-basis');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/analytics/cost-basis', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest({ portfolioId: 'p1' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when portfolioId missing', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it('returns 404 when portfolio not found', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(null);
    const res = await GET(makeRequest({ portfolioId: 'p1' }));
    expect(res.status).toBe(404);
  });

  it('returns cost basis for portfolio with holdings', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue({
      _id: 'p1',
      userId: 'user-1',
      holdings: [
        {
          symbol: 'BTCUSDT',
          transactions: [
            {
              type: 'buy',
              quantity: 1,
              price: 40000,
              date: new Date('2024-01-15'),
              fee: 10,
            },
            {
              type: 'sell',
              quantity: 0.5,
              price: 60000,
              date: new Date('2024-06-15'),
              fee: 5,
            },
          ],
        },
      ],
    } as never);

    const res = await GET(makeRequest({ portfolioId: 'p1' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.costBasis.holdings).toHaveLength(1);
    expect(data.costBasis.holdings[0].symbol).toBe('BTCUSDT');
    expect(data.costBasis.holdings[0].totalQuantity).toBeCloseTo(0.5);
    expect(data.costBasis.totalRealizedGain).toBeGreaterThan(0);
  });

  it('returns empty cost basis for portfolio with no holdings', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue({
      _id: 'p1',
      userId: 'user-1',
      holdings: [],
    } as never);

    const res = await GET(makeRequest({ portfolioId: 'p1' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.costBasis.holdings).toHaveLength(0);
    expect(data.costBasis.totalRealizedGain).toBe(0);
  });

  it('enforces ownership check', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(null);

    const res = await GET(makeRequest({ portfolioId: 'other-user-portfolio' }));
    expect(res.status).toBe(404);
    expect(Portfolio.findOne).toHaveBeenCalledWith({
      _id: 'other-user-portfolio',
      userId: 'user-1',
    });
  });
});
