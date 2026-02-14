// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/candle-ingestion', () => ({
  syncCandles: vi.fn(),
}));

vi.mock('@/lib/models/strategy', () => ({
  Strategy: {
    find: vi.fn(),
  },
}));

vi.mock('@/lib/models/watchlist', () => ({
  Watchlist: {
    find: vi.fn(),
  },
}));

import { GET } from './route';
import { syncCandles } from '@/lib/candle-ingestion';
import { Strategy } from '@/lib/models/strategy';
import { Watchlist } from '@/lib/models/watchlist';

function makeRequest(secret?: string, params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/cron/sync-candles');
  if (params) {
    for (const [key, val] of Object.entries(params)) {
      url.searchParams.set(key, val);
    }
  }
  const headers: Record<string, string> = {};
  if (secret) headers.authorization = `Bearer ${secret}`;
  return new NextRequest(url, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', 'test-secret');
});

describe('GET /api/cron/sync-candles', () => {
  it('returns 401 without cron secret', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong secret', async () => {
    const res = await GET(makeRequest('wrong-secret'));
    expect(res.status).toBe(401);
  });

  it('syncs standard intervals by default', async () => {
    vi.mocked(Strategy.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([
        { symbols: ['BTCUSDT'] },
      ]),
    } as never);
    vi.mocked(Watchlist.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as never);
    vi.mocked(syncCandles).mockResolvedValue({ inserted: 10 });

    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);
    const data = await res.json();

    // Default intervals: 15m, 1h, 4h, 1d = 4 pairs for 1 symbol
    expect(data.pairs).toBe(4);
    expect(data.synced).toBe(4);
    expect(data.totalInserted).toBe(40);
    expect(data.intervals).toEqual(['15m', '1h', '4h', '1d']);
  });

  it('parses custom intervals from query param', async () => {
    vi.mocked(Strategy.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([
        { symbols: ['BTCUSDT'] },
      ]),
    } as never);
    vi.mocked(Watchlist.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as never);
    vi.mocked(syncCandles).mockResolvedValue({ inserted: 5 });

    const res = await GET(makeRequest('test-secret', { intervals: '1m,5m' }));
    const data = await res.json();

    expect(data.intervals).toEqual(['1m', '5m']);
    expect(data.pairs).toBe(2); // 1 symbol x 2 intervals
    expect(data.synced).toBe(2);
  });

  it('falls back to standard intervals for invalid interval values', async () => {
    vi.mocked(Strategy.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([
        { symbols: ['BTCUSDT'] },
      ]),
    } as never);
    vi.mocked(Watchlist.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as never);
    vi.mocked(syncCandles).mockResolvedValue({ inserted: 0 });

    const res = await GET(makeRequest('test-secret', { intervals: 'invalid,nope' }));
    const data = await res.json();

    // Falls back to standard
    expect(data.intervals).toEqual(['15m', '1h', '4h', '1d']);
  });

  it('deduplicates symbols across strategies and watchlists', async () => {
    vi.mocked(Strategy.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([
        { symbols: ['BTCUSDT', 'ETHUSDT'] },
        { symbols: ['BTCUSDT'] },
      ]),
    } as never);
    vi.mocked(Watchlist.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([
        { symbols: ['ETHUSDT', 'SOLUSDT'] },
      ]),
    } as never);
    vi.mocked(syncCandles).mockResolvedValue({ inserted: 1 });

    const res = await GET(makeRequest('test-secret', { intervals: '1h' }));
    const data = await res.json();

    // 3 unique symbols (BTC, ETH, SOL) x 1 interval
    expect(data.pairs).toBe(3);
    expect(data.synced).toBe(3);
  });

  it('limits to MAX_PAIRS_PER_RUN (20)', async () => {
    // 6 symbols x 4 intervals = 24 pairs, capped at 20
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT'];
    vi.mocked(Strategy.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([{ symbols }]),
    } as never);
    vi.mocked(Watchlist.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as never);
    vi.mocked(syncCandles).mockResolvedValue({ inserted: 1 });

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();

    expect(data.pairs).toBe(20);
    expect(data.synced).toBe(20);
  });

  it('counts errors from failed syncs', async () => {
    vi.mocked(Strategy.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([
        { symbols: ['BTCUSDT'] },
      ]),
    } as never);
    vi.mocked(Watchlist.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as never);
    vi.mocked(syncCandles)
      .mockResolvedValueOnce({ inserted: 5 })
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ inserted: 3 })
      .mockRejectedValueOnce(new Error('timeout'));

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();

    expect(data.synced).toBe(2);
    expect(data.errors).toBe(2);
    expect(data.totalInserted).toBe(8);
  });

  it('returns 0 pairs when no strategies or watchlists', async () => {
    vi.mocked(Strategy.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as never);
    vi.mocked(Watchlist.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as never);

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();

    expect(data.pairs).toBe(0);
    expect(data.synced).toBe(0);
    expect(data.totalInserted).toBe(0);
    expect(syncCandles).not.toHaveBeenCalled();
  });

  it('filters valid intervals from mixed input', async () => {
    vi.mocked(Strategy.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([
        { symbols: ['BTCUSDT'] },
      ]),
    } as never);
    vi.mocked(Watchlist.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as never);
    vi.mocked(syncCandles).mockResolvedValue({ inserted: 2 });

    const res = await GET(makeRequest('test-secret', { intervals: '1m,invalid,5m' }));
    const data = await res.json();

    // Only valid intervals kept
    expect(data.intervals).toEqual(['1m', '5m']);
    expect(data.pairs).toBe(2);
  });
});
