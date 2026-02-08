// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticker24h } from '@/types/market';

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
}));

vi.mock('@/lib/binance', () => ({
  fetchTickers: vi.fn(),
}));

import { GET } from './route';
import { cachedFetch } from '@/lib/redis';

const mockTickers: Ticker24h[] = [
  {
    symbol: 'BTCUSDT',
    lastPrice: '50000',
    priceChange: '1000',
    priceChangePercent: '2.0',
    highPrice: '51000',
    lowPrice: '49000',
    volume: '1000',
    quoteVolume: '50000000',
    openPrice: '49000',
    count: 100000,
  },
  {
    symbol: 'ETHUSDT',
    lastPrice: '3000',
    priceChange: '50',
    priceChangePercent: '1.7',
    highPrice: '3100',
    lowPrice: '2900',
    volume: '5000',
    quoteVolume: '15000000',
    openPrice: '2950',
    count: 80000,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/prices', () => {
  it('returns filtered tickers on success', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockTickers);

    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual(mockTickers);
  });

  it('calls cachedFetch with correct key and TTL', async () => {
    vi.mocked(cachedFetch).mockResolvedValue([]);

    await GET();

    expect(cachedFetch).toHaveBeenCalledWith(
      'tickers:top',
      expect.any(Function),
      30
    );
  });

  it('returns 500 when upstream fails', async () => {
    vi.mocked(cachedFetch).mockRejectedValue(new Error('Binance down'));

    const res = await GET();
    expect(res.status).toBe(500);

    const data = await res.json();
    expect(data.error).toBe('Failed to fetch prices');
  });
});
