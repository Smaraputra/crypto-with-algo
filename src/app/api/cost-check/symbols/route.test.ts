// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CostCheckError, CostCheckSymbolsResponse } from '@/types/cost-check';

const mockAuth = vi.fn();
const mockRateLimitUser = vi.fn();
const store = new Map<string, string>();

vi.mock('@/lib/auth', () => ({ auth: () => mockAuth() }));
vi.mock('@/lib/rate-limit', () => ({
  authenticatedLimiter: {},
  rateLimitUser: (...args: unknown[]) => mockRateLimitUser(...args),
}));
vi.mock('@/lib/redis', () => ({
  redis: null,
  cachedFetch: async (key: string, fetcher: () => Promise<unknown>) => {
    const hit = store.get(key);
    if (hit !== undefined) return JSON.parse(hit);
    const data = await fetcher();
    store.set(key, JSON.stringify(data));
    return data;
  },
}));

import { GET } from './route';

function stubExchangeInfo(status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status === 200,
      status,
      headers: new Headers(),
      json: async () => ({
        symbols: [
          { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN', onboardDate: 2, filters: [] },
          { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN', onboardDate: 1, filters: [] },
          { symbol: 'XAUUSDT', baseAsset: 'XAU', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COMMODITY', onboardDate: 3, filters: [] },
        ],
      }),
    }))
  );
}

beforeEach(() => {
  store.clear();
  mockAuth.mockReset().mockResolvedValue({ user: { id: 'u1' } });
  mockRateLimitUser.mockReset().mockResolvedValue(null);
  stubExchangeInfo();
});

describe('GET /api/cost-check/symbols', () => {
  it('401s without a session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it('lists crypto perpetuals sorted by symbol', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as CostCheckSymbolsResponse;
    expect(body.symbols).toEqual([
      { symbol: 'BTCUSDT', baseAsset: 'BTC', onboardDate: 1 },
      { symbol: 'ETHUSDT', baseAsset: 'ETH', onboardDate: 2 },
    ]);
    expect(body.stale).toBe(false);
    expect(typeof body.asOf).toBe('number');
  });

  it('503s venue_unreachable when the venue refuses', async () => {
    stubExchangeInfo(451);
    const res = await GET();
    expect(res.status).toBe(503);
    expect(((await res.json()) as CostCheckError).error).toBe('venue_unreachable');
  });
});
