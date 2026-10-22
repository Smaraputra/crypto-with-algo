// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OHLCV } from '@/types/market';
import { DAY_MS } from '@/lib/market/levels';
import {
  MTF_INTERVALS,
  MTF_INTERVAL_MS,
  type MtfInterval,
} from '@/lib/market/mtf';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(async (_key: string, fetcher: () => Promise<unknown>) =>
    fetcher()
  ),
}));

vi.mock('@/lib/binance-futures', () => ({
  fetchPerpKlinesOhlcv: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: vi.fn(() => 'mock-limiter'),
  rateLimit: vi.fn(() => null),
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { cachedFetch } from '@/lib/redis';
import { fetchPerpKlinesOhlcv } from '@/lib/binance-futures';

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/focus/mtf');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

const mockSession = { user: { id: 'user-1' } };

function generateCandles(interval: MtfInterval, nowMs: number): OHLCV[] {
  if (interval === '1d') {
    const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
    const candles: OHLCV[] = [];
    for (let i = 25; i >= 0; i--) {
      candles.push({
        timestamp: todayStart - i * DAY_MS,
        open: 100,
        high: 110,
        low: 90,
        close: 100,
        volume: 1000,
        takerBuyVolume: 500,
      });
    }
    return candles;
  }

  const stepMs = MTF_INTERVAL_MS[interval];
  const barStart = Math.floor(nowMs / stepMs) * stepMs;
  const candles: OHLCV[] = [];
  for (let i = 60; i >= 0; i--) {
    candles.push({
      timestamp: barStart - i * stepMs,
      open: 100,
      high: 110,
      low: 90,
      close: 100,
      volume: 1000,
      takerBuyVolume: 500,
    });
  }
  return candles;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue(mockSession as never);
  vi.mocked(cachedFetch).mockImplementation(
    async (_key: string, fetcher: () => Promise<unknown>) => fetcher()
  );
  vi.mocked(fetchPerpKlinesOhlcv).mockImplementation(
    async (_symbol: string, interval: string) =>
      generateCandles(interval as MtfInterval, Date.now())
  );
});

describe('GET /api/focus/mtf', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 for symbol=btc (lowercase)', async () => {
    const res = await GET(makeRequest({ symbol: 'btc' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 for symbol=BTCUSD (non-USDT pair)', async () => {
    const res = await GET(makeRequest({ symbol: 'BTCUSD' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 when symbol query parameter is missing', async () => {
    const res = await GET(makeRequest({}));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 200 with four states in order, with cache keys focus:perp-klines:BTCUSDT:<interval>:200', async () => {
    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.symbol).toBe('BTCUSDT');
    expect(data.states).toHaveLength(4);
    expect(data.states.map((s: { interval: string }) => s.interval)).toEqual([
      ...MTF_INTERVALS,
    ]);

    for (const state of data.states) {
      expect(state).not.toHaveProperty('error');
      expect(state.trend).toBeDefined();
      expect(state.asOf).not.toBeNull();
    }

    expect(data.priorDay).not.toBeNull();
    expect(data.priorDay.high).toBe(110);
    expect(data.priorDay.low).toBe(90);
    expect(data.priorDay.close).toBe(100);
    expect(data.priorDay.atr).toBe(20);

    expect(res.headers.get('Cache-Control')).toBe('private, max-age=30');

    expect(cachedFetch).toHaveBeenCalledWith(
      'focus:perp-klines:BTCUSDT:15m:200',
      expect.any(Function),
      60
    );
    expect(cachedFetch).toHaveBeenCalledWith(
      'focus:perp-klines:BTCUSDT:1h:200',
      expect.any(Function),
      120
    );
    expect(cachedFetch).toHaveBeenCalledWith(
      'focus:perp-klines:BTCUSDT:4h:200',
      expect.any(Function),
      300
    );
    expect(cachedFetch).toHaveBeenCalledWith(
      'focus:perp-klines:BTCUSDT:1d:200',
      expect.any(Function),
      600
    );

    const calls = vi.mocked(cachedFetch).mock.calls;
    expect(calls.map((c) => c[0])).toEqual([
      'focus:perp-klines:BTCUSDT:15m:200',
      'focus:perp-klines:BTCUSDT:1h:200',
      'focus:perp-klines:BTCUSDT:4h:200',
      'focus:perp-klines:BTCUSDT:1d:200',
    ]);

    for (const call of calls) {
      expect(call[0]).toMatch(/^focus:perp-klines:BTCUSDT:/);
      expect(call[0]).not.toMatch(/^klines:/);
      expect(call[0]).not.toMatch(/^prices:klines:/);
    }
  });

  it('one interval rejecting gives that row error: true while the others are fine', async () => {
    vi.mocked(fetchPerpKlinesOhlcv).mockImplementation(
      async (_symbol: string, interval: string) => {
        if (interval === '1h') {
          throw new Error('Binance 1h fetch error');
        }
        return generateCandles(interval as MtfInterval, Date.now());
      }
    );

    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.states).toHaveLength(4);
    expect(data.states[0].interval).toBe('15m');
    expect(data.states[0]).not.toHaveProperty('error');

    expect(data.states[1]).toEqual({ interval: '1h', error: true });

    expect(data.states[2].interval).toBe('4h');
    expect(data.states[2]).not.toHaveProperty('error');

    expect(data.states[3].interval).toBe('1d');
    expect(data.states[3]).not.toHaveProperty('error');

    expect(data.priorDay).not.toBeNull();
  });

  it('computes priorDay from 1d candles, and returns null when the 1d fetch rejects', async () => {
    vi.mocked(fetchPerpKlinesOhlcv).mockImplementation(
      async (_symbol: string, interval: string) => {
        if (interval === '1d') {
          throw new Error('Binance 1d fetch error');
        }
        return generateCandles(interval as MtfInterval, Date.now());
      }
    );

    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.states[3]).toEqual({ interval: '1d', error: true });
    expect(data.priorDay).toBeNull();
  });

  it('returns priorDay as null when 1d candles are fewer than required bars', async () => {
    vi.mocked(fetchPerpKlinesOhlcv).mockImplementation(
      async (_symbol: string, interval: string) => {
        if (interval === '1d') {
          return generateCandles('1d', Date.now()).slice(-5);
        }
        return generateCandles(interval as MtfInterval, Date.now());
      }
    );

    const res = await GET(makeRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.states[3].interval).toBe('1d');
    expect(data.states[3]).not.toHaveProperty('error');
    expect(data.priorDay).toBeNull();
  });
});
