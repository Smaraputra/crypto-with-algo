// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/portfolio', () => ({
  Portfolio: {
    findOne: vi.fn(),
  },
}));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { Portfolio } from '@/lib/models/portfolio';

const mockSession = { user: { id: 'user-1' } };
const makeParams = (id: string, symbol: string) => ({
  params: Promise.resolve({ id, symbol }),
});

function makeRequest(body?: unknown): NextRequest {
  if (body === undefined) {
    return new NextRequest(
      'http://localhost/api/portfolio/p1/holdings/BTCUSDT/transactions',
      { method: 'GET' }
    );
  }
  return new NextRequest(
    'http://localhost/api/portfolio/p1/holdings/BTCUSDT/transactions',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

const mockTransactions = [
  { type: 'buy', quantity: 1, price: 40000, date: new Date('2024-01-01'), fee: 0 },
  { type: 'buy', quantity: 0.5, price: 45000, date: new Date('2024-02-01'), fee: 0 },
];

function makePortfolioWithHolding() {
  return {
    _id: 'p1',
    userId: 'user-1',
    holdings: [
      {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        quantity: 1.5,
        avgBuyPrice: 41666.67,
        transactions: [...mockTransactions],
      },
    ],
    save: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/portfolio/[id]/holdings/[symbol]/transactions', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET(makeRequest(), makeParams('p1', 'BTCUSDT'));
    expect(res.status).toBe(401);
  });

  it('returns transactions sorted by date descending', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(makePortfolioWithHolding() as never);

    const res = await GET(makeRequest(), makeParams('p1', 'BTCUSDT'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.transactions).toHaveLength(2);
    expect(new Date(data.transactions[0].date).getTime()).toBeGreaterThan(
      new Date(data.transactions[1].date).getTime()
    );
  });

  it('returns 404 when portfolio not found', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(null);

    const res = await GET(makeRequest(), makeParams('p1', 'BTCUSDT'));
    expect(res.status).toBe(404);
  });

  it('returns 404 when holding not found', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue({
      _id: 'p1',
      holdings: [],
    } as never);

    const res = await GET(makeRequest(), makeParams('p1', 'XRPUSDT'));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/portfolio/[id]/holdings/[symbol]/transactions', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest({ type: 'buy', quantity: 0.5, price: 50000 });
    const res = await POST(req, makeParams('p1', 'BTCUSDT'));
    expect(res.status).toBe(401);
  });

  it('records buy transaction and recalculates state', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockPortfolio = makePortfolioWithHolding();
    vi.mocked(Portfolio.findOne).mockResolvedValue(mockPortfolio as never);

    const req = makeRequest({ type: 'buy', quantity: 0.5, price: 50000 });
    const res = await POST(req, makeParams('p1', 'BTCUSDT'));
    expect(res.status).toBe(200);
    expect(mockPortfolio.holdings[0].transactions).toHaveLength(3);
    expect(mockPortfolio.save).toHaveBeenCalled();
  });

  it('records sell transaction', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockPortfolio = makePortfolioWithHolding();
    vi.mocked(Portfolio.findOne).mockResolvedValue(mockPortfolio as never);

    const req = makeRequest({ type: 'sell', quantity: 0.5, price: 50000 });
    const res = await POST(req, makeParams('p1', 'BTCUSDT'));
    expect(res.status).toBe(200);
    expect(mockPortfolio.holdings[0].quantity).toBe(1);
  });

  it('returns 400 for oversell', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockPortfolio = makePortfolioWithHolding();
    vi.mocked(Portfolio.findOne).mockResolvedValue(mockPortfolio as never);

    const req = makeRequest({ type: 'sell', quantity: 5, price: 50000 });
    const res = await POST(req, makeParams('p1', 'BTCUSDT'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('exceeds');
  });

  it('returns 400 for invalid input', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const req = makeRequest({ type: 'invalid' });
    const res = await POST(req, makeParams('p1', 'BTCUSDT'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when holding not found', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue({
      _id: 'p1',
      holdings: [],
    } as never);

    const req = makeRequest({ type: 'buy', quantity: 1, price: 40000 });
    const res = await POST(req, makeParams('p1', 'BTCUSDT'));
    expect(res.status).toBe(404);
  });
});
