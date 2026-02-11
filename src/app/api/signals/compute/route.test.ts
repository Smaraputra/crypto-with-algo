// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OHLCV } from '@/types/market';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
}));

vi.mock('@/lib/binance', () => ({
  fetchKlines: vi.fn(),
}));

vi.mock('@/lib/binance-futures', () => ({
  fetchFundingRate: vi.fn(),
  fetchLongShortRatio: vi.fn(),
}));

vi.mock('@/lib/external/fear-greed', () => ({
  fetchFearAndGreed: vi.fn().mockResolvedValue({
    fearGreedIndex: 50,
    label: 'Neutral',
  }),
}));

vi.mock('@/lib/models/signal', () => ({
  Signal: {
    create: vi.fn().mockResolvedValue({ _id: 'signal-1' }),
  },
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { cachedFetch } from '@/lib/redis';

const mockSession = { user: { id: 'user-1' } };

function generateCandles(count: number): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 40000;
  const baseTime = Date.now() - count * 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    const change = (Math.sin(i * 0.1) * 0.01 + 0.001) * price;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;

    candles.push({
      timestamp: baseTime + i * 60 * 60 * 1000,
      open, high, low, close,
      volume: 100 + Math.random() * 200,
    });
    price = close;
  }

  return candles;
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/signals/compute', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/signals/compute', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing symbol', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('computes signal successfully', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const candles = generateCandles(500);

    // cachedFetch: first call is candles, then funding rate in fetchFuturesDataSafe, then L/S ratio
    vi.mocked(cachedFetch)
      .mockResolvedValueOnce(candles)
      .mockResolvedValueOnce([{ symbol: 'BTCUSDT', fundingRate: 0.0001, fundingTime: 0, markPrice: 40000 }])
      .mockResolvedValueOnce([{ symbol: 'BTCUSDT', longShortRatio: 1.0, longAccount: 0.5, shortAccount: 0.5, timestamp: 0 }]);

    const res = await POST(makeRequest({ symbol: 'BTCUSDT', interval: '1h' }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.signal).toBeDefined();
    expect(data.signal.symbol).toBe('BTCUSDT');
    expect(data.signal.score).toBeDefined();
    expect(data.signal.tier).toBeDefined();
    expect(data.signal._id).toBe('signal-1');
  });

  it('handles upstream error gracefully', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(cachedFetch).mockRejectedValue(new Error('Binance down'));

    const res = await POST(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('Binance down');
  });

  it('defaults interval to 1h', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const candles = generateCandles(500);
    vi.mocked(cachedFetch)
      .mockResolvedValueOnce(candles)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await POST(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.signal.interval).toBe('1h');
  });
});
