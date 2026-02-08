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
  const url = new URL('http://localhost/api/analytics/export');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

const mockPortfolio = {
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
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/analytics/export', () => {
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

  it('returns CSV with correct headers', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(mockPortfolio as never);

    const res = await GET(makeRequest({ portfolioId: 'p1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv');
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="tax-report.csv"'
    );

    const csv = await res.text();
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'Date,Type,Asset,Quantity,Price (USD),Fee (USD),Proceeds (USD),Cost Basis (USD),Gain/Loss (USD),Holding Period'
    );
    expect(lines.length).toBeGreaterThan(1);
  });

  it('includes year in filename when year param provided', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(mockPortfolio as never);

    const res = await GET(makeRequest({ portfolioId: 'p1', year: '2024' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="tax-report-2024.csv"'
    );
  });

  it('filters transactions by year', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(mockPortfolio as never);

    const res = await GET(makeRequest({ portfolioId: 'p1', year: '2025' }));
    const csv = await res.text();
    const lines = csv.split('\n');
    // Only header, no data rows for 2025
    expect(lines).toHaveLength(1);
  });

  it('contains buy and sell rows in CSV', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(mockPortfolio as never);

    const res = await GET(makeRequest({ portfolioId: 'p1' }));
    const csv = await res.text();

    expect(csv).toContain('Buy');
    expect(csv).toContain('Sell');
    expect(csv).toContain('BTC');
    expect(csv).toContain('2024-01-15');
    expect(csv).toContain('2024-06-15');
  });

  it('returns empty CSV body for portfolio with no holdings', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue({
      _id: 'p1',
      userId: 'user-1',
      holdings: [],
    } as never);

    const res = await GET(makeRequest({ portfolioId: 'p1' }));
    expect(res.status).toBe(200);
    const csv = await res.text();
    const lines = csv.split('\n');
    expect(lines).toHaveLength(1); // Header only
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
