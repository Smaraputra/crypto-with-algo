// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/models/portfolio', () => ({
  Portfolio: { findOne: vi.fn() },
}));
vi.mock('@/lib/models/portfolio-snapshot', () => ({
  PortfolioSnapshot: {
    find: vi.fn().mockReturnValue({ sort: vi.fn().mockResolvedValue([]) }),
  },
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { Portfolio } from '@/lib/models/portfolio';
import { PortfolioSnapshot } from '@/lib/models/portfolio-snapshot';

const mockSession = { user: { id: 'user-1' } };

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost/api/analytics/history');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/analytics/history', () => {
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

  it('returns history for valid request', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue({ _id: 'p1' } as never);
    const mockSnapshots = [
      {
        date: new Date('2024-01-15'),
        totalValue: 26000,
        totalCost: 25000,
        unrealizedPnl: 1000,
        unrealizedPnlPercent: 4,
      },
    ];
    vi.mocked(PortfolioSnapshot.find).mockReturnValue({
      sort: vi.fn().mockResolvedValue(mockSnapshots),
    } as never);

    const res = await GET(makeRequest({ portfolioId: 'p1', range: '30' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.history).toHaveLength(1);
    expect(data.history[0].totalValue).toBe(26000);
  });

  it('defaults range to 30 when not specified', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue({ _id: 'p1' } as never);
    const sortMock = vi.fn().mockResolvedValue([]);
    vi.mocked(PortfolioSnapshot.find).mockReturnValue({ sort: sortMock } as never);

    await GET(makeRequest({ portfolioId: 'p1' }));

    expect(PortfolioSnapshot.find).toHaveBeenCalledWith(
      expect.objectContaining({
        portfolioId: 'p1',
        date: expect.objectContaining({ $gte: expect.any(Date) }),
      })
    );
  });

  it('enforces ownership check', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(null);

    const res = await GET(makeRequest({ portfolioId: 'other-users-portfolio' }));
    expect(res.status).toBe(404);
    expect(Portfolio.findOne).toHaveBeenCalledWith({
      _id: 'other-users-portfolio',
      userId: 'user-1',
    });
  });
});
