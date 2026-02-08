// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
}));

vi.mock('@/lib/binance', () => ({
  fetchSymbols: vi.fn(),
}));

import { GET } from './route';
import { cachedFetch } from '@/lib/redis';

const mockSymbols = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/symbols', () => {
  it('returns symbols from cache', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockSymbols);

    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual(mockSymbols);
  });

  it('uses 1 hour TTL for cache', async () => {
    vi.mocked(cachedFetch).mockResolvedValue(mockSymbols);

    await GET();

    expect(cachedFetch).toHaveBeenCalledWith(
      'symbols:usdt',
      expect.any(Function),
      3600
    );
  });

  it('returns 500 when upstream fails', async () => {
    vi.mocked(cachedFetch).mockRejectedValue(new Error('Binance down'));

    const res = await GET();
    expect(res.status).toBe(500);

    const data = await res.json();
    expect(data.error).toBe('Failed to fetch symbols');
  });
});
