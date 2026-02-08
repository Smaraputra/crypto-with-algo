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

import { POST } from './route';
import { auth } from '@/lib/auth';
import { Portfolio } from '@/lib/models/portfolio';

const mockSession = { user: { id: 'user-1' } };
const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/portfolio/p1/holdings', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const validInput = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  type: 'buy',
  quantity: 0.5,
  price: 40000,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/portfolio/[id]/holdings', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest(validInput);
    const res = await POST(req, makeParams('p1'));
    expect(res.status).toBe(401);
  });

  it('returns 404 when portfolio not found', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(null);

    const req = makeRequest(validInput);
    const res = await POST(req, makeParams('p1'));
    expect(res.status).toBe(404);
  });

  it('creates new holding with buy transaction', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const holdings: Record<string, unknown>[] = [];
    const mockPortfolio = {
      _id: 'p1',
      userId: 'user-1',
      holdings,
      save: vi.fn(),
    };
    vi.mocked(Portfolio.findOne).mockResolvedValue(mockPortfolio as never);

    const req = makeRequest(validInput);
    const res = await POST(req, makeParams('p1'));
    expect(res.status).toBe(200);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].symbol).toBe('BTCUSDT');
    expect(holdings[0].quantity).toBe(0.5);
    expect(holdings[0].avgBuyPrice).toBe(40000);
    expect(mockPortfolio.save).toHaveBeenCalled();
  });

  it('appends transaction to existing holding', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockPortfolio = {
      _id: 'p1',
      userId: 'user-1',
      holdings: [
        {
          symbol: 'BTCUSDT',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          quantity: 0.5,
          avgBuyPrice: 40000,
          transactions: [
            { type: 'buy', quantity: 0.5, price: 40000, date: new Date(), fee: 0 },
          ],
        },
      ],
      save: vi.fn(),
    };
    vi.mocked(Portfolio.findOne).mockResolvedValue(mockPortfolio as never);

    const req = makeRequest({ ...validInput, quantity: 0.5, price: 50000 });
    const res = await POST(req, makeParams('p1'));
    expect(res.status).toBe(200);
    expect(mockPortfolio.holdings[0].transactions).toHaveLength(2);
    expect(mockPortfolio.holdings[0].quantity).toBe(1);
    expect(mockPortfolio.holdings[0].avgBuyPrice).toBe(45000);
  });

  it('returns 400 for sell without holding', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockPortfolio = {
      _id: 'p1',
      userId: 'user-1',
      holdings: [],
      save: vi.fn(),
    };
    vi.mocked(Portfolio.findOne).mockResolvedValue(mockPortfolio as never);

    const req = makeRequest({ ...validInput, type: 'sell' });
    const res = await POST(req, makeParams('p1'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('do not hold');
  });

  it('returns 400 for overselling', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockPortfolio = {
      _id: 'p1',
      userId: 'user-1',
      holdings: [
        {
          symbol: 'BTCUSDT',
          quantity: 0.5,
          avgBuyPrice: 40000,
          transactions: [
            { type: 'buy', quantity: 0.5, price: 40000, date: new Date(), fee: 0 },
          ],
        },
      ],
      save: vi.fn(),
    };
    vi.mocked(Portfolio.findOne).mockResolvedValue(mockPortfolio as never);

    const req = makeRequest({ ...validInput, type: 'sell', quantity: 1.0 });
    const res = await POST(req, makeParams('p1'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('exceeds');
  });

  it('returns 400 for invalid input', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const req = makeRequest({ symbol: '' });
    const res = await POST(req, makeParams('p1'));
    expect(res.status).toBe(400);
  });
});
