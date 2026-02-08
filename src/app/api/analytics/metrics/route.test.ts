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
  const url = new URL('http://localhost/api/analytics/metrics');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/analytics/metrics', () => {
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

  it('returns insufficient data when no snapshots', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue({ _id: 'p1' } as never);
    vi.mocked(PortfolioSnapshot.find).mockReturnValue({
      sort: vi.fn().mockResolvedValue([]),
    } as never);

    const res = await GET(makeRequest({ portfolioId: 'p1' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.insufficientData).toBe(true);
    expect(data.metrics).toBeNull();
    expect(data.dataPoints).toBe(0);
    expect(data.minRequired).toBe(30);
  });

  it('returns metrics when sufficient snapshots exist', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue({ _id: 'p1' } as never);

    const snapshots = Array.from({ length: 31 }, (_, i) => {
      const d = new Date('2024-01-01');
      d.setUTCDate(d.getUTCDate() + i);
      return {
        date: d,
        totalValue: 10000 + i * 100 + Math.sin(i) * 200,
      };
    });
    vi.mocked(PortfolioSnapshot.find).mockReturnValue({
      sort: vi.fn().mockResolvedValue(snapshots),
    } as never);

    const res = await GET(makeRequest({ portfolioId: 'p1', range: '90' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.insufficientData).toBe(false);
    expect(data.metrics).not.toBeNull();
    expect(data.metrics.sharpeRatio).not.toBeNull();
    expect(data.dataPoints).toBe(31);
  });

  it('defaults range to 90 when not specified', async () => {
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
});
