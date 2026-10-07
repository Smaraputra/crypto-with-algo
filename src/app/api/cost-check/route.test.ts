// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { CostCheckError, CostCheckMarketResponse } from '@/types/cost-check';

const mockAuth = vi.fn();
const mockRateLimitUser = vi.fn();
const store = new Map<string, string>();
const cacheKeys: string[] = [];

vi.mock('@/lib/auth', () => ({ auth: () => mockAuth() }));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ limit: vi.fn() }),
  rateLimitUser: (...args: unknown[]) => mockRateLimitUser(...args),
}));
vi.mock('@/lib/redis', () => {
  const redis = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
  return {
    redis,
    cachedFetch: async (key: string, fetcher: () => Promise<unknown>) => {
      cacheKeys.push(key);
      const hit = store.get(key);
      if (hit !== undefined) return JSON.parse(hit);
      const data = await fetcher();
      store.set(key, JSON.stringify(data));
      return data;
    },
  };
});

import { GET } from './route';

const NOW = 1_800_000_000_000;
const MIN15 = 15 * 60_000;

function exchangeSymbol(symbol: string, over: Record<string, unknown> = {}) {
  return {
    symbol,
    baseAsset: symbol.replace('USDT', ''),
    quoteAsset: 'USDT',
    status: 'TRADING',
    contractType: 'PERPETUAL',
    underlyingType: 'COIN',
    onboardDate: 1_569_398_400_000,
    filters: [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PRICE_FILTER', tickSize: '0.1' },
    ],
    ...over,
  };
}

/** `count` closed 15m bars ending before NOW, then one in-progress bar. */
function klineRows(count: number, interval = MIN15) {
  const rows: unknown[][] = [];
  const start = NOW - (count + 0.5) * interval;
  for (let i = 0; i <= count; i++) {
    const openTime = start + i * interval;
    const closed = i < count;
    // In-progress bar carries an absurd close that must never reach the stats.
    const close = closed ? 100 + (i % 2) : 1_000_000;
    rows.push([openTime, '100', '101', '99', String(close), '1', openTime + interval - 1, '100', 1, '1', '1', '0']);
  }
  return rows;
}

interface Venue {
  klineCount: number;
  failWith?: { status: number; retryAfter?: string };
  failEverything?: 'network';
  depthFails?: boolean;
}

let calls: string[];

function stubVenue(venue: Venue) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      if (venue.failEverything === 'network') throw new TypeError('fetch failed');
      if (venue.failWith) {
        return {
          ok: false,
          status: venue.failWith.status,
          headers: new Headers(venue.failWith.retryAfter ? { 'Retry-After': venue.failWith.retryAfter } : {}),
          json: async () => ({ msg: 'secret upstream text' }),
        };
      }
      const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
      switch (url.pathname) {
        case '/fapi/v1/exchangeInfo':
          return ok({
            symbols: [exchangeSymbol('BTCUSDT'), exchangeSymbol('XAUUSDT', { underlyingType: 'COMMODITY' })],
          });
        case '/fapi/v1/klines':
          return ok(klineRows(venue.klineCount));
        case '/fapi/v1/premiumIndex':
          return ok({ markPrice: '60000', lastFundingRate: '0.0001', nextFundingTime: NOW + 3_600_000 });
        case '/fapi/v1/fundingInfo':
          return ok([{ symbol: 'ETHUSDT', fundingIntervalHours: 4 }]);
        case '/fapi/v1/depth':
          if (venue.depthFails) return { ok: false, status: 500, headers: new Headers(), json: async () => ({}) };
          return ok({
            bids: [['59990', '10']],
            asks: [['60010', '10']],
          });
        default:
          throw new Error(`unexpected ${url.pathname}`);
      }
    })
  );
}

function request(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/cost-check');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

const GOOD = { symbol: 'BTCUSDT', holdMinutes: '60', notional: '1000' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  store.clear();
  cacheKeys.length = 0;
  mockAuth.mockReset().mockResolvedValue({ user: { id: 'u1' } });
  mockRateLimitUser.mockReset().mockResolvedValue(null);
  stubVenue({ klineCount: 200 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GET /api/cost-check', () => {
  it('401s without a session', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(request(GOOD));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('rate limits on a dedicated key and passes the limiter response through', async () => {
    mockRateLimitUser.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), { status: 429 })
    );
    const res = await GET(request(GOOD));
    expect(res.status).toBe(429);
    expect(mockRateLimitUser.mock.calls[0][0]).toBe('cost-check:u1');
  });

  it.each([
    ['lowercase symbol', { ...GOOD, symbol: 'btcusdt' }],
    ['no USDT suffix', { ...GOOD, symbol: 'BTCUSDC' }],
    ['injection', { ...GOOD, symbol: 'BTCUSDT&limit=1' }],
    ['missing symbol', { holdMinutes: '60' }],
    ['non-integer hold', { ...GOOD, holdMinutes: '1.5' }],
    ['zero hold', { ...GOOD, holdMinutes: '0' }],
    ['hold over 30 days', { ...GOOD, holdMinutes: '43201' }],
    ['missing hold', { symbol: 'BTCUSDT' }],
    ['zero notional', { ...GOOD, notional: '0' }],
    ['negative notional', { ...GOOD, notional: '-5' }],
    ['huge notional', { ...GOOD, notional: '10000001' }],
    ['text notional', { ...GOOD, notional: 'abc' }],
  ])('400s on %s before any venue call', async (_name, params) => {
    const res = await GET(request(params));
    expect(res.status).toBe(400);
    expect(((await res.json()) as CostCheckError).error).toBe('invalid_request');
    expect(calls).toEqual([]);
  });

  it('404s on a symbol that is not a crypto USDT perpetual', async () => {
    const res = await GET(request({ ...GOOD, symbol: 'XAUUSDT' }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as CostCheckError).error).toBe('unknown_symbol');
    const unknown = await GET(request({ ...GOOD, symbol: 'NOPEUSDT' }));
    expect(unknown.status).toBe(404);
  });

  it('returns the market facts for a 60 minute hold measured on 15m x 4', async () => {
    const res = await GET(request(GOOD));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CostCheckMarketResponse;
    expect(body.symbol).toBe('BTCUSDT');
    expect(body.stale).toBe(false);
    expect(body.asOf).toBe(NOW);
    expect(body.markPrice).toBe(60000);
    expect(body.funding).toEqual({ rate: 0.0001, intervalHours: 8, nextFundingTime: NOW + 3_600_000 });
    expect(body.venue).toEqual({
      minNotional: 5,
      minQty: 0.001,
      stepSize: 0.001,
      tickSize: 0.1,
      effectiveMinNotional: 60,
    });
    expect(body.measurement).toEqual({
      interval: '15m',
      holdBars: 4,
      measuredHoldMs: 4 * MIN15,
      // 200 closed bars; the in-progress one is dropped.
      barsUsed: 200,
    });
    expect(body.onboardDate).toBe(1_569_398_400_000);
    expect(body.move).not.toBeNull();
    // Closes alternate 100 / 101 and the hold is an even 4 bars, so every move is 0.
    expect(body.move?.meanPercent).toBe(0);
    expect(body.move?.samples).toBe(196);
    expect(body.slippage.source).toBe('depth');
    expect(body.slippage.bps).toBeCloseTo((10 / 60000) * 10_000, 6);
    expect(body.slippage.halfSpreadBps).toBeCloseTo((10 / 60000) * 10_000, 6);
    expect(body.slippage.exceedsTopOfBook).toBe(false);
  });

  it('uses the funding interval the venue lists for an adjusted symbol', async () => {
    store.set(
      'cost-check:fundinginfo',
      JSON.stringify({ BTCUSDT: 4 })
    );
    const body = (await (await GET(request(GOOD))).json()) as CostCheckMarketResponse;
    expect(body.funding.intervalHours).toBe(4);
  });

  it('returns move null when there are fewer bars than one window', async () => {
    stubVenue({ klineCount: 4 });
    const body = (await (await GET(request(GOOD))).json()) as CostCheckMarketResponse;
    expect(body.measurement.barsUsed).toBe(4);
    expect(body.move).toBeNull();
  });

  it('falls back to 5 bps when depth fails', async () => {
    stubVenue({ klineCount: 50, depthFails: true });
    const body = (await (await GET(request(GOOD))).json()) as CostCheckMarketResponse;
    expect(body.slippage).toEqual({ bps: 5, source: 'fallback', halfSpreadBps: null, exceedsTopOfBook: false });
  });

  it('flags a notional the visible book cannot fill', async () => {
    const body = (await (await GET(request({ ...GOOD, notional: '5000000' }))).json()) as CostCheckMarketResponse;
    expect(body.slippage.exceedsTopOfBook).toBe(true);
  });

  it('caches klines per symbol and interval, not per hold', async () => {
    await GET(request({ ...GOOD, holdMinutes: '60' }));
    await GET(request({ ...GOOD, holdMinutes: '75' }));
    const klineCalls = calls.filter((c) => c.startsWith('/fapi/v1/klines'));
    expect(klineCalls).toHaveLength(1);
    expect(cacheKeys.filter((k) => k.startsWith('cost-check:klines:'))).toEqual([
      'cost-check:klines:BTCUSDT:15m',
      'cost-check:klines:BTCUSDT:15m',
    ]);
    await GET(request({ ...GOOD, holdMinutes: '600' }));
    expect(cacheKeys).toContain('cost-check:klines:BTCUSDT:1h');
  });

  it('uses the documented cache keys and writes the last-good copy', async () => {
    await GET(request(GOOD));
    expect(cacheKeys).toEqual(
      expect.arrayContaining([
        'cost-check:exinfo',
        'cost-check:fundinginfo',
        'cost-check:premium:BTCUSDT',
        'cost-check:depth:BTCUSDT',
      ])
    );
    expect(store.has('cost-check:last-good:BTCUSDT:15m:4')).toBe(true);
  });

  it('503s venue_unreachable on a 451', async () => {
    stubVenue({ klineCount: 10, failWith: { status: 451 } });
    const res = await GET(request(GOOD));
    expect(res.status).toBe(503);
    const body = (await res.json()) as CostCheckError;
    expect(body.error).toBe('venue_unreachable');
    expect(JSON.stringify(body)).not.toContain('secret upstream');
  });

  it('503s venue_unreachable on a 403 and on a network error', async () => {
    stubVenue({ klineCount: 10, failWith: { status: 403 } });
    expect(((await (await GET(request(GOOD))).json()) as CostCheckError).error).toBe('venue_unreachable');
    stubVenue({ klineCount: 10, failEverything: 'network' });
    const res = await GET(request(GOOD));
    expect(res.status).toBe(503);
    expect(((await res.json()) as CostCheckError).error).toBe('venue_unreachable');
  });

  it('503s venue_rate_limited with Retry-After on a 429', async () => {
    stubVenue({ klineCount: 10, failWith: { status: 429, retryAfter: '30' } });
    const res = await GET(request(GOOD));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({
      error: 'venue_rate_limited',
      message: expect.any(String),
      retryAfterSeconds: 30,
    });
  });

  it('maps a 418 ban without a Retry-After header', async () => {
    stubVenue({ klineCount: 10, failWith: { status: 418 } });
    const res = await GET(request(GOOD));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBeNull();
    const body = (await res.json()) as CostCheckError;
    expect(body.error).toBe('venue_rate_limited');
    expect(body.retryAfterSeconds).toBeUndefined();
  });

  it('serves the last-good copy as stale, keeping its original asOf', async () => {
    const first = (await (await GET(request(GOOD))).json()) as CostCheckMarketResponse;
    // Expire the short caches, keep the last-good copy.
    for (const key of [...store.keys()]) if (!key.startsWith('cost-check:last-good:')) store.delete(key);
    vi.setSystemTime(NOW + 3_600_000);
    stubVenue({ klineCount: 10, failWith: { status: 429, retryAfter: '5' } });
    const res = await GET(request(GOOD));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CostCheckMarketResponse;
    expect(body.stale).toBe(true);
    expect(body.asOf).toBe(first.asOf);
    expect(body.markPrice).toBe(first.markPrice);
  });
});
