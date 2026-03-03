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
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

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

function mockEmptyDB() {
  vi.mocked(Strategy.find).mockReturnValue({
    select: vi.fn().mockResolvedValue([]),
  } as never);
  vi.mocked(Watchlist.find).mockReturnValue({
    select: vi.fn().mockResolvedValue([]),
  } as never);
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

  it('always includes SIGNAL_SYMBOLS even with no strategies or watchlists', async () => {
    mockEmptyDB();
    vi.mocked(syncCandles).mockResolvedValue({ inserted: 1 });

    const res = await GET(makeRequest('test-secret', { intervals: '1h' }));
    const data = await res.json();

    // 10 SIGNAL_SYMBOLS x 1 interval = 10 pairs
    expect(data.pairs).toBe(SIGNAL_SYMBOLS.length);
    expect(data.synced).toBe(SIGNAL_SYMBOLS.length);
    expect(syncCandles).toHaveBeenCalledTimes(SIGNAL_SYMBOLS.length);

    // Verify all signal symbols were synced
    const syncedSymbols = vi.mocked(syncCandles).mock.calls.map((c) => c[0]);
    for (const sym of SIGNAL_SYMBOLS) {
      expect(syncedSymbols).toContain(sym);
    }
  });

  it('syncs standard intervals by default', async () => {
    mockEmptyDB();
    vi.mocked(syncCandles).mockResolvedValue({ inserted: 1 });

    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);
    const data = await res.json();

    // 10 SIGNAL_SYMBOLS x 4 intervals = 40 pairs
    expect(data.pairs).toBe(40);
    expect(data.synced).toBe(40);
    expect(data.intervals).toEqual(['15m', '1h', '4h', '1d']);
  });

  it('parses custom intervals from query param', async () => {
    mockEmptyDB();
    vi.mocked(syncCandles).mockResolvedValue({ inserted: 5 });

    const res = await GET(makeRequest('test-secret', { intervals: '1m,5m' }));
    const data = await res.json();

    expect(data.intervals).toEqual(['1m', '5m']);
    // 10 symbols x 2 intervals = 20 pairs
    expect(data.pairs).toBe(20);
    expect(data.synced).toBe(20);
  });

  it('falls back to standard intervals for invalid interval values', async () => {
    mockEmptyDB();
    vi.mocked(syncCandles).mockResolvedValue({ inserted: 0 });

    const res = await GET(makeRequest('test-secret', { intervals: 'invalid,nope' }));
    const data = await res.json();

    expect(data.intervals).toEqual(['15m', '1h', '4h', '1d']);
  });

  it('deduplicates symbols across strategies, watchlists, and SIGNAL_SYMBOLS', async () => {
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

    // BTC, ETH, SOL from strategies/watchlists + 7 more from SIGNAL_SYMBOLS = 10
    expect(data.pairs).toBe(10);
    expect(data.synced).toBe(10);
  });

  it('includes extra strategy symbols beyond SIGNAL_SYMBOLS', async () => {
    vi.mocked(Strategy.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([
        { symbols: ['BTCUSDT', 'MATICUSDT', 'AAVEUSDT'] },
      ]),
    } as never);
    vi.mocked(Watchlist.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as never);
    vi.mocked(syncCandles).mockResolvedValue({ inserted: 1 });

    const res = await GET(makeRequest('test-secret', { intervals: '1h' }));
    const data = await res.json();

    // 10 SIGNAL_SYMBOLS + MATICUSDT + AAVEUSDT = 12 x 1 interval
    expect(data.pairs).toBe(12);
    expect(data.synced).toBe(12);
  });

  it('limits to MAX_PAIRS_PER_RUN (50)', async () => {
    // 14 symbols x 4 intervals = 56 pairs, capped at 50
    const extraSymbols = ['MATICUSDT', 'AAVEUSDT', 'UNIUSDT', 'SHIBUSDT'];
    vi.mocked(Strategy.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([{ symbols: extraSymbols }]),
    } as never);
    vi.mocked(Watchlist.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as never);
    vi.mocked(syncCandles).mockResolvedValue({ inserted: 1 });

    const res = await GET(makeRequest('test-secret'));
    const data = await res.json();

    expect(data.pairs).toBe(50);
    expect(data.synced).toBe(50);
  });

  it('counts errors from failed syncs', async () => {
    mockEmptyDB();
    let callCount = 0;
    vi.mocked(syncCandles).mockImplementation(async () => {
      callCount++;
      if (callCount % 3 === 0) throw new Error('network error');
      return { inserted: 1 };
    });

    const res = await GET(makeRequest('test-secret', { intervals: '1h' }));
    const data = await res.json();

    // 10 symbols, every 3rd fails = 3 errors, 7 synced
    expect(data.synced).toBe(7);
    expect(data.errors).toBe(3);
    expect(data.totalInserted).toBe(7);
  });

  it('filters valid intervals from mixed input', async () => {
    mockEmptyDB();
    vi.mocked(syncCandles).mockResolvedValue({ inserted: 2 });

    const res = await GET(makeRequest('test-secret', { intervals: '1m,invalid,5m' }));
    const data = await res.json();

    // Only valid intervals kept
    expect(data.intervals).toEqual(['1m', '5m']);
    // 10 symbols x 2 intervals = 20
    expect(data.pairs).toBe(20);
  });
});
