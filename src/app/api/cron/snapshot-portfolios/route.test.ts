// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/portfolio', () => ({
  Portfolio: {
    find: vi.fn(),
  },
}));

vi.mock('@/lib/models/portfolio-snapshot', () => ({
  PortfolioSnapshot: {
    findOneAndUpdate: vi.fn(),
  },
  truncateToMidnightUTC: vi.fn((d: Date) => {
    const result = new Date(d);
    result.setUTCHours(0, 0, 0, 0);
    return result;
  }),
}));

vi.mock('@/lib/binance', () => ({
  fetchTickerPrices: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn((_key: string, fetcher: () => Promise<unknown>) => fetcher()),
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

import { GET } from './route';
import { Portfolio } from '@/lib/models/portfolio';
import { PortfolioSnapshot } from '@/lib/models/portfolio-snapshot';
import { fetchTickerPrices } from '@/lib/binance';
import { redis } from '@/lib/redis';

function makeRequest(secret?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (secret) {
    headers['authorization'] = `Bearer ${secret}`;
  }
  return new NextRequest('http://localhost/api/cron/snapshot-portfolios', {
    method: 'GET',
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', 'test-secret');
  vi.mocked(redis!.get).mockResolvedValue(null);
  vi.mocked(redis!.set).mockResolvedValue(undefined);
});

describe('GET /api/cron/snapshot-portfolios', () => {
  it('returns 401 without valid CRON_SECRET', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong secret', async () => {
    const res = await GET(makeRequest('wrong-secret'));
    expect(res.status).toBe(401);
  });

  it('skips when Redis indicates already run today', async () => {
    vi.mocked(redis!.get).mockResolvedValue('1');

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.skipped).toBe(true);
    expect(data.reason).toBe('already-run-today');
  });

  it('returns early when no portfolios with holdings', async () => {
    vi.mocked(Portfolio.find).mockResolvedValue([]);

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.snapshots).toBe(0);
    expect(data.portfolios).toBe(0);
  });

  it('creates snapshot for portfolio with holdings', async () => {
    vi.mocked(Portfolio.find).mockResolvedValue([
      {
        _id: { toString: () => 'p1' },
        userId: 'user-1',
        holdings: [
          { symbol: 'BTCUSDT', quantity: 0.5, avgBuyPrice: 40000 },
          { symbol: 'ETHUSDT', quantity: 2.0, avgBuyPrice: 2500 },
        ],
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({
      BTCUSDT: 42000,
      ETHUSDT: 2800,
    });
    vi.mocked(PortfolioSnapshot.findOneAndUpdate).mockResolvedValue({} as never);

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.snapshots).toBe(1);
    expect(data.portfolios).toBe(1);

    expect(PortfolioSnapshot.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ portfolioId: 'p1' }),
      expect.objectContaining({
        userId: 'user-1',
        totalValue: 0.5 * 42000 + 2.0 * 2800,
        totalCost: 0.5 * 40000 + 2.0 * 2500,
      }),
      { upsert: true, new: true }
    );
  });

  it('skips holdings with zero quantity', async () => {
    vi.mocked(Portfolio.find).mockResolvedValue([
      {
        _id: { toString: () => 'p1' },
        userId: 'user-1',
        holdings: [
          { symbol: 'BTCUSDT', quantity: 0, avgBuyPrice: 40000 },
          { symbol: 'ETHUSDT', quantity: 2.0, avgBuyPrice: 2500 },
        ],
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({ ETHUSDT: 2800 });
    vi.mocked(PortfolioSnapshot.findOneAndUpdate).mockResolvedValue({} as never);

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.snapshots).toBe(1);

    const updateCall = vi.mocked(PortfolioSnapshot.findOneAndUpdate).mock.calls[0];
    const snapshotData = updateCall[1] as Record<string, unknown>;
    expect(snapshotData.totalValue).toBe(2.0 * 2800);
    expect((snapshotData.holdings as unknown[]).length).toBe(1);
  });

  it('skips holdings with missing price', async () => {
    vi.mocked(Portfolio.find).mockResolvedValue([
      {
        _id: { toString: () => 'p1' },
        userId: 'user-1',
        holdings: [
          { symbol: 'BTCUSDT', quantity: 0.5, avgBuyPrice: 40000 },
          { symbol: 'NEWCOIN', quantity: 100, avgBuyPrice: 1 },
        ],
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({ BTCUSDT: 42000 });
    vi.mocked(PortfolioSnapshot.findOneAndUpdate).mockResolvedValue({} as never);

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.snapshots).toBe(1);

    const updateCall = vi.mocked(PortfolioSnapshot.findOneAndUpdate).mock.calls[0];
    const snapshotData = updateCall[1] as Record<string, unknown>;
    expect(snapshotData.totalValue).toBe(0.5 * 42000);
  });

  it('handles multiple portfolios', async () => {
    vi.mocked(Portfolio.find).mockResolvedValue([
      {
        _id: { toString: () => 'p1' },
        userId: 'user-1',
        holdings: [{ symbol: 'BTCUSDT', quantity: 1, avgBuyPrice: 40000 }],
      },
      {
        _id: { toString: () => 'p2' },
        userId: 'user-2',
        holdings: [{ symbol: 'ETHUSDT', quantity: 5, avgBuyPrice: 2000 }],
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({
      BTCUSDT: 50000,
      ETHUSDT: 3000,
    });
    vi.mocked(PortfolioSnapshot.findOneAndUpdate).mockResolvedValue({} as never);

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.snapshots).toBe(2);
    expect(data.portfolios).toBe(2);
  });

  it('continues on partial failure (one portfolio errors)', async () => {
    vi.mocked(Portfolio.find).mockResolvedValue([
      {
        _id: { toString: () => 'p1' },
        userId: 'user-1',
        holdings: [{ symbol: 'BTCUSDT', quantity: 1, avgBuyPrice: 40000 }],
      },
      {
        _id: { toString: () => 'p2' },
        userId: 'user-2',
        holdings: [{ symbol: 'ETHUSDT', quantity: 5, avgBuyPrice: 2000 }],
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({
      BTCUSDT: 50000,
      ETHUSDT: 3000,
    });
    vi.mocked(PortfolioSnapshot.findOneAndUpdate)
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce({} as never);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.snapshots).toBe(1);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('sets Redis dedup key after successful run', async () => {
    vi.mocked(Portfolio.find).mockResolvedValue([
      {
        _id: { toString: () => 'p1' },
        userId: 'user-1',
        holdings: [{ symbol: 'BTCUSDT', quantity: 1, avgBuyPrice: 40000 }],
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({ BTCUSDT: 50000 });
    vi.mocked(PortfolioSnapshot.findOneAndUpdate).mockResolvedValue({} as never);

    await GET(makeRequest('test-secret'));

    expect(redis!.set).toHaveBeenCalledWith(
      expect.stringMatching(/^snapshot:\d{4}-\d{2}-\d{2}$/),
      '1',
      { ex: 86400 }
    );
  });

  it('uses upsert for idempotent re-runs', async () => {
    vi.mocked(Portfolio.find).mockResolvedValue([
      {
        _id: { toString: () => 'p1' },
        userId: 'user-1',
        holdings: [{ symbol: 'BTCUSDT', quantity: 1, avgBuyPrice: 40000 }],
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({ BTCUSDT: 50000 });
    vi.mocked(PortfolioSnapshot.findOneAndUpdate).mockResolvedValue({} as never);

    await GET(makeRequest('test-secret'));

    expect(PortfolioSnapshot.findOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ upsert: true })
    );
  });
});
