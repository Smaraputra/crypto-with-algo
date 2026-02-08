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

import { DELETE } from './route';
import { auth } from '@/lib/auth';
import { Portfolio } from '@/lib/models/portfolio';

const mockSession = { user: { id: 'user-1' } };
const makeParams = (id: string, symbol: string) => ({
  params: Promise.resolve({ id, symbol }),
});

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/portfolio/p1/holdings/BTCUSDT', {
    method: 'DELETE',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DELETE /api/portfolio/[id]/holdings/[symbol]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await DELETE(makeRequest(), makeParams('p1', 'BTCUSDT'));
    expect(res.status).toBe(401);
  });

  it('removes holding from portfolio', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockPortfolio = {
      _id: 'p1',
      userId: 'user-1',
      holdings: [
        { symbol: 'BTCUSDT', quantity: 0.5 },
        { symbol: 'ETHUSDT', quantity: 2.0 },
      ],
      save: vi.fn(),
    };
    vi.mocked(Portfolio.findOne).mockResolvedValue(mockPortfolio as never);

    const res = await DELETE(makeRequest(), makeParams('p1', 'BTCUSDT'));
    expect(res.status).toBe(200);
    expect(mockPortfolio.holdings).toHaveLength(1);
    expect(mockPortfolio.holdings[0].symbol).toBe('ETHUSDT');
    expect(mockPortfolio.save).toHaveBeenCalled();
  });

  it('returns 404 when portfolio not found', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(null);

    const res = await DELETE(makeRequest(), makeParams('p1', 'BTCUSDT'));
    expect(res.status).toBe(404);
  });

  it('returns 404 when holding not found', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockPortfolio = {
      _id: 'p1',
      userId: 'user-1',
      holdings: [{ symbol: 'ETHUSDT', quantity: 2.0 }],
      save: vi.fn(),
    };
    vi.mocked(Portfolio.findOne).mockResolvedValue(mockPortfolio as never);

    const res = await DELETE(makeRequest(), makeParams('p1', 'BTCUSDT'));
    expect(res.status).toBe(404);
  });

  it('verifies ownership before deleting', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(null);

    const res = await DELETE(makeRequest(), makeParams('other-users-portfolio', 'BTCUSDT'));
    expect(res.status).toBe(404);
    expect(Portfolio.findOne).toHaveBeenCalledWith({
      _id: 'other-users-portfolio',
      userId: 'user-1',
    });
  });
});
