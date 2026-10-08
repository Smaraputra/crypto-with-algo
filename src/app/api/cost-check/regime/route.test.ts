// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CostCheckError, CostCheckRegimeResponse } from '@/types/cost-check';

const mockAuth = vi.fn();
const mockRateLimitUser = vi.fn();
const store = new Map<string, string>();
const cacheKeys: string[] = [];
const ttls = new Map<string, number>();

vi.mock('@/lib/auth', () => ({ auth: () => mockAuth() }));
vi.mock('@/lib/rate-limit', () => ({
  authenticatedLimiter: { limit: vi.fn() },
  createRateLimiter: () => ({ limit: vi.fn() }),
  rateLimitUser: (...args: unknown[]) => mockRateLimitUser(...args),
}));
vi.mock('@/lib/redis', () => ({
  redis: {
    get: async (key: string) => {
      cacheKeys.push(key);
      return store.get(key) ?? null;
    },
    set: async (key: string, value: string, opts: { ex: number }) => {
      store.set(key, value);
      ttls.set(key, opts.ex);
    },
  },
  cachedFetch: async () => {
    throw new Error('the regime route manages its own cache');
  },
}));

import { GET } from './route';

const H = 3_600_000;
const DAY = 86_400_000;
/** 2026-10-08 00:30 UTC: the last complete day is 2026-10-07. */
const NOW = Date.UTC(2026, 9, 8, 0, 30);
const MEASURED = Date.UTC(2026, 9, 7);

let calls: URL[];

/** Hourly bars for the requested range; the measured day moves `lastDayMove` an hour, earlier days 0.1%. */
function stubKlines(lastDayMove: number, failStatus?: number, missingHour?: number) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      if (failStatus) return { ok: false, status: failStatus, headers: new Headers(), json: async () => ({ msg: 'upstream' }) };
      const start = Number(url.searchParams.get('startTime'));
      const end = Number(url.searchParams.get('endTime'));
      const limit = Number(url.searchParams.get('limit'));
      const rows: unknown[][] = [];
      // Binance returns the bars whose open time is at or after startTime, on the interval's grid.
      for (let t = Math.ceil(start / H) * H; t <= end && rows.length < limit; t += H) {
        if (t === missingHour) continue;
        const move = t >= MEASURED ? lastDayMove : 0.001;
        const open = 100;
        const close = (Math.floor(t / H) % 2 === 0 ? 1 + move : 1 - move) * open;
        rows.push([t, String(open), '0', '0', String(close), '1', t + H - 1, '1000', 1, '1', '1', '0']);
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => rows };
    })
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  store.clear();
  ttls.clear();
  cacheKeys.length = 0;
  mockAuth.mockReset().mockResolvedValue({ user: { id: 'u1' } });
  mockRateLimitUser.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GET /api/cost-check/regime', () => {
  it('requires a session', async () => {
    mockAuth.mockResolvedValue(null);
    stubKlines(0.02);
    expect((await GET()).status).toBe(401);
  });

  it('ranks the last complete UTC day of BTCUSDT against the 180 before it', async () => {
    stubKlines(0.02);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as CostCheckRegimeResponse;
    expect(body.symbol).toBe('BTCUSDT');
    expect(body.regime?.day).toBe(MEASURED);
    expect(body.regime?.high).toBe(true);
    expect(body.regime?.trailingDays).toBe(180);
    // 181 days of hourly bars from 180 days before the measured day, in three pages.
    expect(calls).toHaveLength(3);
    expect(calls[0].searchParams.get('symbol')).toBe('BTCUSDT');
    expect(calls[0].searchParams.get('interval')).toBe('1h');
    expect(Number(calls[0].searchParams.get('startTime'))).toBe(MEASURED - 180 * DAY);
    expect(Number(calls[0].searchParams.get('endTime'))).toBe(MEASURED + 23 * H);
  });

  it('caches per measured day', async () => {
    stubKlines(0.0005);
    const first = (await (await GET()).json()) as CostCheckRegimeResponse;
    expect(first.regime?.high).toBe(false);
    await GET();
    expect(calls).toHaveLength(3);
    expect(cacheKeys).toEqual([`cost-check:regime:BTCUSDT:${MEASURED}`, `cost-check:regime:BTCUSDT:${MEASURED}`]);
    expect(ttls.get(`cost-check:regime:BTCUSDT:${MEASURED}`)).toBe(6 * 3600);
  });

  it('caches a day it could not measure for five minutes only', async () => {
    stubKlines(0.02, undefined, MEASURED + 7 * H);
    const body = (await (await GET()).json()) as CostCheckRegimeResponse;
    expect(body.regime).toBeNull();
    expect(ttls.get(`cost-check:regime:BTCUSDT:${MEASURED}`)).toBe(300);
  });

  it('maps a venue failure to a sanitised 503', async () => {
    stubKlines(0.02, 451);
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as CostCheckError;
    expect(body.error).toBe('venue_unreachable');
    expect(JSON.stringify(body)).not.toContain('upstream');
  });

  it('honours the rate limit', async () => {
    mockRateLimitUser.mockResolvedValue(new Response(null, { status: 429 }));
    stubKlines(0.02);
    expect((await GET()).status).toBe(429);
  });
});
