// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/alert', () => ({
  Alert: {
    find: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('@/lib/models/portfolio', () => ({
  Portfolio: {
    find: vi.fn(),
  },
}));

vi.mock('@/lib/binance', () => ({
  fetchTickerPrices: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn((_key: string, fetcher: () => Promise<unknown>) => fetcher()),
}));

import { GET } from './route';
import { Alert } from '@/lib/models/alert';
import { Portfolio } from '@/lib/models/portfolio';
import { fetchTickerPrices } from '@/lib/binance';

function makeRequest(secret?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (secret) {
    headers['authorization'] = `Bearer ${secret}`;
  }
  return new NextRequest('http://localhost/api/cron/check-alerts', {
    method: 'GET',
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', 'test-secret');
});

describe('GET /api/cron/check-alerts', () => {
  it('returns 401 without valid CRON_SECRET', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong secret', async () => {
    const res = await GET(makeRequest('wrong-secret'));
    expect(res.status).toBe(401);
  });

  it('returns early when no active alerts', async () => {
    vi.mocked(Alert.find).mockResolvedValue([]);

    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.evaluated).toBe(0);
    expect(data.triggered).toBe(0);
  });

  it('triggers price_above alert when price meets target', async () => {
    vi.mocked(Alert.find).mockResolvedValue([
      {
        _id: 'a1',
        type: 'price_above',
        symbol: 'BTCUSDT',
        targetPrice: 100000,
        status: 'active',
        recurring: false,
        percentChange: null,
        referencePrice: null,
        portfolioId: null,
        lastTriggeredAt: null,
        cooldownMinutes: 60,
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({ BTCUSDT: 105000 });
    vi.mocked(Alert.updateOne).mockResolvedValue({} as never);

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.evaluated).toBe(1);
    expect(data.triggered).toBe(1);
    expect(Alert.updateOne).toHaveBeenCalledWith(
      { _id: 'a1' },
      expect.objectContaining({ status: 'triggered' })
    );
  });

  it('does not trigger price_above when price below target', async () => {
    vi.mocked(Alert.find).mockResolvedValue([
      {
        _id: 'a1',
        type: 'price_above',
        symbol: 'BTCUSDT',
        targetPrice: 100000,
        status: 'active',
        recurring: false,
        percentChange: null,
        referencePrice: null,
        portfolioId: null,
        lastTriggeredAt: null,
        cooldownMinutes: 60,
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({ BTCUSDT: 95000 });

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.triggered).toBe(0);
    expect(Alert.updateOne).not.toHaveBeenCalled();
  });

  it('triggers price_below alert correctly', async () => {
    vi.mocked(Alert.find).mockResolvedValue([
      {
        _id: 'a1',
        type: 'price_below',
        symbol: 'ETHUSDT',
        targetPrice: 3000,
        status: 'active',
        recurring: false,
        percentChange: null,
        referencePrice: null,
        portfolioId: null,
        lastTriggeredAt: null,
        cooldownMinutes: 60,
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({ ETHUSDT: 2500 });
    vi.mocked(Alert.updateOne).mockResolvedValue({} as never);

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.triggered).toBe(1);
  });

  it('triggers price_change_pct alert when threshold exceeded', async () => {
    vi.mocked(Alert.find).mockResolvedValue([
      {
        _id: 'a1',
        type: 'price_change_pct',
        symbol: 'BTCUSDT',
        targetPrice: null,
        percentChange: 5,
        referencePrice: 100000,
        status: 'active',
        recurring: false,
        portfolioId: null,
        lastTriggeredAt: null,
        cooldownMinutes: 60,
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({ BTCUSDT: 106000 });
    vi.mocked(Alert.updateOne).mockResolvedValue({} as never);

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.triggered).toBe(1);
  });

  it('skips recurring alert within cooldown', async () => {
    const recentTime = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    vi.mocked(Alert.find).mockResolvedValue([
      {
        _id: 'a1',
        type: 'price_above',
        symbol: 'BTCUSDT',
        targetPrice: 100000,
        status: 'active',
        recurring: true,
        cooldownMinutes: 60,
        percentChange: null,
        referencePrice: null,
        portfolioId: null,
        lastTriggeredAt: recentTime,
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({ BTCUSDT: 105000 });

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.triggered).toBe(0);
    expect(Alert.updateOne).not.toHaveBeenCalled();
  });

  it('triggers recurring alert outside cooldown', async () => {
    const oldTime = new Date(Date.now() - 120 * 60 * 1000); // 2 hours ago
    vi.mocked(Alert.find).mockResolvedValue([
      {
        _id: 'a1',
        type: 'price_above',
        symbol: 'BTCUSDT',
        targetPrice: 100000,
        status: 'active',
        recurring: true,
        cooldownMinutes: 60,
        percentChange: null,
        referencePrice: null,
        portfolioId: null,
        lastTriggeredAt: oldTime,
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({ BTCUSDT: 105000 });
    vi.mocked(Alert.updateOne).mockResolvedValue({} as never);

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.triggered).toBe(1);
    expect(Alert.updateOne).toHaveBeenCalledWith(
      { _id: 'a1' },
      expect.objectContaining({ lastTriggeredAt: expect.any(Date) })
    );
  });

  it('evaluates portfolio_value_above alert', async () => {
    vi.mocked(Alert.find).mockResolvedValue([
      {
        _id: 'a1',
        type: 'portfolio_value_above',
        symbol: '',
        portfolioId: 'p1',
        targetPrice: 50000,
        status: 'active',
        recurring: false,
        percentChange: null,
        referencePrice: null,
        lastTriggeredAt: null,
        cooldownMinutes: 60,
      },
    ]);
    vi.mocked(Portfolio.find).mockResolvedValue([
      {
        _id: { toString: () => 'p1' },
        holdings: [
          { symbol: 'BTCUSDT', quantity: 0.5 },
          { symbol: 'ETHUSDT', quantity: 10 },
        ],
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({
      BTCUSDT: 100000,
      ETHUSDT: 3000,
    });
    vi.mocked(Alert.updateOne).mockResolvedValue({} as never);

    // Portfolio value = 0.5*100000 + 10*3000 = 80000 > 50000
    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.triggered).toBe(1);
  });

  it('evaluates holding_change_pct alert', async () => {
    vi.mocked(Alert.find).mockResolvedValue([
      {
        _id: 'a1',
        type: 'holding_change_pct',
        symbol: 'BTCUSDT',
        portfolioId: 'p1',
        targetPrice: null,
        percentChange: -10,
        referencePrice: null,
        status: 'active',
        recurring: false,
        lastTriggeredAt: null,
        cooldownMinutes: 60,
      },
    ]);
    vi.mocked(Portfolio.find).mockResolvedValue([
      {
        _id: { toString: () => 'p1' },
        holdings: [
          { symbol: 'BTCUSDT', quantity: 0.5, avgBuyPrice: 50000 },
        ],
      },
    ]);
    vi.mocked(fetchTickerPrices).mockResolvedValue({ BTCUSDT: 40000 });
    vi.mocked(Alert.updateOne).mockResolvedValue({} as never);

    // pct change = (40000-50000)/50000 * 100 = -20% => |−20| >= |−10|
    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();
    expect(data.triggered).toBe(1);
  });
});
