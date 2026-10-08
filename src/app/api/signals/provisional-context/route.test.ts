import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

import { buildCandles, seedFor } from '@/__fixtures__/scoring-fixture';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { intervalToMs } from '@/lib/intervals';
import type { OHLCV } from '@/types/market';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rateLimitUser: vi.fn(),
  getCandles: vi.fn(),
  fetchFearAndGreed: vi.fn(),
  fetchFearAndGreedUncached: vi.fn(),
  fetchKlines: vi.fn(),
  cacheKeys: [] as string[],
  snapshotAggregate: vi.fn(),
  snapshotFind: vi.fn(),
  templateFindOne: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: () => mocks.auth() }));
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => null,
  rateLimitUser: (...args: unknown[]) => mocks.rateLimitUser(...args),
}));
vi.mock('@/lib/redis', () => ({
  cachedFetch: (key: string, fn: () => Promise<unknown>) => {
    mocks.cacheKeys.push(key);
    return fn();
  },
}));
vi.mock('@/lib/candle-ingestion', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/candle-ingestion')>('@/lib/candle-ingestion');
  return {
    dropOpenBars: actual.dropOpenBars,
    getCandles: (...args: unknown[]) => mocks.getCandles(...args),
  };
});
vi.mock('@/lib/binance', () => ({ fetchKlines: (...a: unknown[]) => mocks.fetchKlines(...a) }));
vi.mock('@/lib/external/fear-greed', () => ({
  fetchFearAndGreed: () => mocks.fetchFearAndGreed(),
  fetchFearAndGreedUncached: () => mocks.fetchFearAndGreedUncached(),
}));
vi.mock('@/lib/models/historical-snapshot', () => ({
  HistoricalSnapshot: {
    aggregate: (...a: unknown[]) => mocks.snapshotAggregate(...a),
    find: (...a: unknown[]) => ({ sort: () => ({ lean: () => mocks.snapshotFind(...a) }) }),
  },
}));
vi.mock('@/lib/models/signal-template', async () => {
  const actual = await vi.importActual('@/lib/models/signal-template');
  return {
    ...actual,
    SignalTemplate: { findOne: () => ({ lean: () => mocks.templateFindOne() }) },
  };
});

import { GET } from './route';

// 2026-10-09T05:20:00Z: 20 minutes into the 1h bar opening at 05:00
const NOW = Date.UTC(2026, 9, 9, 5, 20, 0, 0);
const FORMING = Date.UTC(2026, 9, 9, 5, 0, 0, 0);
const HOUR = intervalToMs('1h');
const rec = getStyleConfig('day_trading').recommendedCandles;

function request(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/signals/provisional-context');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

const GOOD = { symbol: 'BTCUSDT', interval: '1h', style: 'day_trading' };

/** Mongo-like: closed bars only, newest `limit`, ending at `lastOpen`. */
function candlesUpTo(interval: string, lastOpen: number) {
  return async (_s: string, i: string, _a: unknown, _b: unknown, limit: number): Promise<OHLCV[]> =>
    buildCandles({
      symbol: 'BTCUSDT',
      interval: i,
      count: limit,
      endOpenTime: i === interval ? lastOpen : Math.floor(NOW / intervalToMs(i)) * intervalToMs(i) - intervalToMs(i),
      seed: seedFor('candles', 'BTCUSDT', i),
      startPrice: 60000,
    });
}

describe('GET /api/signals/provisional-context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    mocks.cacheKeys.length = 0;
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    mocks.rateLimitUser.mockResolvedValue(null);
    mocks.getCandles.mockImplementation(candlesUpTo('1h', FORMING - HOUR));
    mocks.fetchFearAndGreedUncached.mockResolvedValue({ fearGreedIndex: 27, label: 'Fear' });
    mocks.fetchFearAndGreed.mockRejectedValue(new Error('shared F&G must not be called'));
    mocks.fetchKlines.mockRejectedValue(new Error('fetchKlines must not be called'));
    mocks.snapshotAggregate.mockResolvedValue([
      { _id: 'BTCUSDT', newsSentiment: { count: 8, avgSentiment: 0.42 } },
    ]);
    mocks.snapshotFind.mockResolvedValue([]);
    mocks.templateFindOne.mockResolvedValue(null);
  });

  it('returns 401 without a session user', async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET(request(GOOD))).status).toBe(401);
    mocks.auth.mockResolvedValue({ user: {} });
    expect((await GET(request(GOOD))).status).toBe(401);
  });

  it('passes a 429 from the rate limiter through', async () => {
    mocks.rateLimitUser.mockResolvedValue(NextResponse.json({ error: 'slow' }, { status: 429 }));
    const res = await GET(request(GOOD));
    expect(res.status).toBe(429);
    expect(mocks.rateLimitUser).toHaveBeenCalledWith('provisional-context:u1', null);
    expect(mocks.getCandles).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-signal symbol', { ...GOOD, symbol: 'PEPEUSDT' }],
    ['a missing symbol', { interval: '1h', style: 'day_trading' }],
    ['an unknown style', { ...GOOD, style: 'hodl' }],
    ['an interval the style does not score', { ...GOOD, interval: '4h' }],
  ])('returns 400 for %s', async (_name, params) => {
    const res = await GET(request(params));
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe('string');
    expect(mocks.getCandles).not.toHaveBeenCalled();
  });

  it('answers awaiting-candle-sync when Mongo lacks the newest closed bar', async () => {
    mocks.getCandles.mockImplementation(candlesUpTo('1h', FORMING - 2 * HOUR));
    const res = await GET(request(GOOD));
    const body = await res.json();
    expect(body).toMatchObject({
      ready: false,
      reason: 'awaiting-candle-sync',
      formingOpenTime: FORMING,
      symbol: 'BTCUSDT',
      style: 'day_trading',
    });
    expect(body.closedCandles).toBeUndefined();
  });

  it('answers insufficient-history when the window is below the style minimum', async () => {
    mocks.getCandles.mockImplementation(async () =>
      buildCandles({
        symbol: 'BTCUSDT',
        interval: '1h',
        count: 50,
        endOpenTime: FORMING - HOUR,
        seed: 1,
        startPrice: 60000,
      })
    );
    const body = await (await GET(request(GOOD))).json();
    expect(body).toMatchObject({ ready: false, reason: 'insufficient-history' });
  });

  it('serves a ready context with the closed window, never a score', async () => {
    const res = await GET(request(GOOD));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.formingOpenTime).toBe(FORMING);
    expect(body.generatedAt).toBe(NOW);
    expect(body.closedCandles).toHaveLength(rec - 1);
    expect(body.closedCandles[body.closedCandles.length - 1].timestamp).toBe(FORMING - HOUR);
    expect(body.closedCandles[0].takerBuyVolume).toBeTypeOf('number');
    expect(body.sentiment).toEqual({
      fearGreedIndex: 27,
      label: 'Fear',
      news: { count: 8, avgSentiment: 0.42 },
    });
    expect(body.htfContext).not.toBeNull();
    for (const key of ['score', 'tier', 'confidence', 'components']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('only uses provisional: cache keys and never the shared fetchers', async () => {
    await GET(request(GOOD));
    expect(mocks.cacheKeys.length).toBeGreaterThan(0);
    for (const key of mocks.cacheKeys) expect(key.startsWith('provisional:')).toBe(true);
    expect(mocks.fetchFearAndGreed).not.toHaveBeenCalled();
    expect(mocks.fetchKlines).not.toHaveBeenCalled();
  });

  it('degrades sentiment to null when Fear and Greed fails', async () => {
    mocks.fetchFearAndGreedUncached.mockRejectedValue(new Error('down'));
    const body = await (await GET(request(GOOD))).json();
    expect(body.ready).toBe(true);
    expect(body.sentiment).toBeNull();
  });
});
