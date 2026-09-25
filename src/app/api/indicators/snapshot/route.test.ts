// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OHLCV } from '@/types/market';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/redis', () => ({ cachedFetch: vi.fn() }));
vi.mock('@/lib/binance', () => ({ fetchKlines: vi.fn() }));

const mockGetCandles = vi.fn();
// dropOpenBars is pure, so keep the real one: the route's closed-bar guarantee
// is part of what these tests check.
vi.mock('@/lib/candle-ingestion', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/candle-ingestion')>('@/lib/candle-ingestion');
  return {
    dropOpenBars: actual.dropOpenBars,
    getCandles: (...args: unknown[]) => mockGetCandles(...args),
  };
});

vi.mock('@/lib/external/fear-greed', () => ({ fetchFearAndGreed: vi.fn() }));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { cachedFetch } from '@/lib/redis';
import { fetchKlines } from '@/lib/binance';
import { fetchFearAndGreed } from '@/lib/external/fear-greed';
import { RECOMMENDED_CANDLES } from '@/lib/indicators/types';

const HOUR = 3600_000;

function generateCandles(count: number, endTime: number): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = 42;
  const next = () => {
    rng = (rng * 16807) % 2147483647;
    return rng / 2147483647;
  };

  for (let i = 0; i < count; i++) {
    price = price * (1 + (next() - 0.48) / 100);
    candles.push({
      timestamp: endTime - (count - 1 - i) * HOUR,
      open: price,
      high: price * 1.01,
      low: price * 0.99,
      close: price,
      volume: 1000 + next() * 100,
    });
  }
  return candles;
}

function request(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/indicators/snapshot?${query}`);
}

const closedEnd = Date.now() - 2 * HOUR;
const candles = generateCandles(RECOMMENDED_CANDLES, closedEnd);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: 'user-1' } } as never);
  vi.mocked(cachedFetch).mockImplementation(
    async (_key: string, producer: () => Promise<unknown>) => producer() as never
  );
  mockGetCandles.mockResolvedValue(candles);
  vi.mocked(fetchFearAndGreed).mockResolvedValue({ fearGreedIndex: 61, label: 'Greed' });
});

describe('GET /api/indicators/snapshot', () => {
  it('rejects an unauthenticated request before touching market data', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET(request('symbol=BTCUSDT&interval=1h'));

    expect(res.status).toBe(401);
    expect(mockGetCandles).not.toHaveBeenCalled();
  });

  it('rejects an interval the candle store does not have', async () => {
    const res = await GET(request('symbol=BTCUSDT&interval=7m'));

    expect(res.status).toBe(400);
  });

  it('returns the reading for the interval that was asked for', async () => {
    // The whole point of the route: the old client path read whichever Signal
    // the legacy cron happened to write last, at whatever interval, while the
    // journal form believed it had asked for one.
    const body = await (await GET(request('symbol=BTCUSDT&interval=1h'))).json();

    expect(body.interval).toBe('1h');
    expect(body.symbol).toBe('BTCUSDT');
    expect(mockGetCandles).toHaveBeenCalledWith('BTCUSDT', '1h', undefined, undefined, expect.any(Number));
  });

  it('fills the fields the prose parser could not reach', async () => {
    const body = await (await GET(request('symbol=BTCUSDT&interval=1h'))).json();

    for (const key of ['bollingerUpper', 'ema12', 'ema26', 'sma50', 'sma200', 'macdSignal', 'macdHistogram', 'stochRsiD']) {
      expect(body.snapshot[key], key).toBeTypeOf('number');
    }
    expect(body.snapshot.fearGreedIndex).toBe(61);
    expect(body.snapshot.fearGreedLabel).toBe('Greed');
  });

  it('stamps the closed bar the reading came from', async () => {
    const body = await (await GET(request('symbol=BTCUSDT&interval=1h'))).json();

    expect(body.candleTimestamp).toBe(closedEnd);
  });

  it('still returns the price reading when sentiment is unavailable', async () => {
    vi.mocked(fetchFearAndGreed).mockRejectedValue(new Error('feed down'));

    const body = await (await GET(request('symbol=BTCUSDT&interval=1h'))).json();

    expect(body.snapshot.rsi).toBeTypeOf('number');
    expect(body.snapshot.fearGreedIndex).toBeNull();
  });

  it('reports too little history as a request problem, not a server fault', async () => {
    const short = candles.slice(-50);
    mockGetCandles.mockResolvedValue(short);
    vi.mocked(fetchKlines).mockResolvedValue(short);

    const res = await GET(request('symbol=BTCUSDT&interval=1h'));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/Insufficient candle data|needs at least/);
  });

  it('refuses to score an open bar', async () => {
    // Every candle still open: dropOpenBars empties the set rather than
    // letting a forming bar into a recorded snapshot.
    // Every bar opens in the future, so none of them has closed.
    const open = generateCandles(RECOMMENDED_CANDLES, Date.now() + RECOMMENDED_CANDLES * HOUR);
    mockGetCandles.mockResolvedValue(open);

    const res = await GET(request('symbol=BTCUSDT&interval=1h'));

    expect(res.status).toBe(503);
  });
});
