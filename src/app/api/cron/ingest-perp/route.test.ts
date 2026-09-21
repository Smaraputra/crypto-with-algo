// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockFetchArchiveFile, mockBulkWrite } = vi.hoisted(() => ({
  mockFetchArchiveFile: vi.fn(),
  mockBulkWrite: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

vi.mock('@/lib/models/perp-candle', () => ({
  PerpCandle: { bulkWrite: (...args: unknown[]) => mockBulkWrite(...args) },
  PERP_SERIES: ['klines', 'premiumIndex', 'markPrice'],
}));

vi.mock('@/lib/external/binance-archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/external/binance-archive')>(
    '@/lib/external/binance-archive'
  );
  return { ...actual, fetchArchiveFile: (...args: unknown[]) => mockFetchArchiveFile(...args) };
});

import { GET } from './route';

const SECRET = 'test-cron-secret';
const DAY_MS = 24 * 60 * 60 * 1000;

/** A kline row whose close identifies which dataset produced it, so a
 * wrong-series write is visible rather than merely wrong. */
function klineCsv(close: number, timestamp: number): string {
  return (
    'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n' +
    `${timestamp},${close},${close},${close},${close},291.86,${timestamp + 299999},23599476.88,9020,103.7,8386513.6,0\n`
  );
}

/** The timestamp every fixture row uses: a fixed pre-lockbox day. */
const BAR_TS = Date.UTC(2026, 8, 19);

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/cron/ingest-perp${query}`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
}

/** Every spec the route handed to the archive in this test. */
function specs(): Record<string, unknown>[] {
  return mockFetchArchiveFile.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

/** Every op every bulkWrite received, flattened. */
function writtenOps(): Record<string, unknown>[] {
  const ops: Record<string, unknown>[] = [];
  for (const call of mockBulkWrite.mock.calls) {
    for (const entry of call[0] as Record<string, unknown>[]) {
      ops.push(entry.updateOne as Record<string, unknown>);
    }
  }
  return ops;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  mockBulkWrite.mockResolvedValue({ upsertedCount: 2, modifiedCount: 0 });
  mockFetchArchiveFile.mockImplementation(({ dataset }: { dataset: string }) =>
    Promise.resolve(klineCsv(dataset === 'klines' ? 100 : 0.0004, BAR_TS))
  );
});

describe('GET /api/cron/ingest-perp', () => {
  it('rejects a bad secret without fetching anything', async () => {
    const res = await GET(
      new NextRequest('http://localhost:3000/api/cron/ingest-perp', {
        headers: { Authorization: 'Bearer wrong' },
      })
    );
    expect(res.status).toBe(401);
    expect(mockFetchArchiveFile).not.toHaveBeenCalled();
  });

  it('covers the default window across symbols, intervals and both series', async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.symbols).toBe(10);
    expect(body.days).toBe(3);
    expect(body.series).toEqual(['klines', 'premiumIndex']);
    expect(body.intervals).toEqual(['5m', '15m', '1h', '4h', '1d']);
    // 10 symbols x 3 days x 5 intervals x 2 series
    expect(body.fetched).toBe(300);
    expect(mockFetchArchiveFile).toHaveBeenCalledTimes(300);

    // Never asks for today: the archive publishes a day late.
    const today = new Date().toISOString().slice(0, 10);
    expect(body.to).not.toBe(today);
    for (const spec of specs()) {
      expect(spec.date).not.toBe(today);
    }
  });

  it('always asks for the DAILY cadence with a day-shaped date', async () => {
    // The whole reason this route exists: the monthly file for the current
    // month does not exist until the month ends.
    await GET(request('?days=1&symbols=BTCUSDT&intervals=1d'));
    const seen = specs();
    expect(seen).toHaveLength(2);
    for (const spec of seen) {
      expect(spec.cadence).toBe('daily');
      expect(spec.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('writes each dataset under its own series, so premium bars cannot overwrite traded bars', async () => {
    await GET(request('?days=1&symbols=BTCUSDT&intervals=5m'));
    const ops = writtenOps();

    const traded = ops.find((op) => (op.filter as Record<string, unknown>).series === 'klines');
    const premium = ops.find(
      (op) => (op.filter as Record<string, unknown>).series === 'premiumIndex'
    );

    expect(traded).toBeDefined();
    expect(premium).toBeDefined();
    // The fixtures differ only in close, so this pins the pairing.
    expect((traded!.update as { $set: { close: number } }).$set.close).toBe(100);
    expect((premium!.update as { $set: { close: number } }).$set.close).toBe(0.0004);
  });

  it('upserts on the model unique key and carries the bar fields', async () => {
    await GET(request('?days=1&symbols=BTCUSDT&intervals=5m'));
    const op = writtenOps().find(
      (candidate) => (candidate.filter as Record<string, unknown>).series === 'klines'
    );
    expect(op).toBeDefined();
    expect(op!.filter).toEqual({
      symbol: 'BTCUSDT',
      interval: '5m',
      series: 'klines',
      timestamp: BAR_TS,
    });
    const set = (op!.update as { $set: Record<string, unknown> }).$set;
    for (const field of ['open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'trades']) {
      expect(set).toHaveProperty(field);
    }
  });

  it('counts an absent archive file as missing, never as an error', async () => {
    mockFetchArchiveFile.mockResolvedValue(null);
    const res = await GET(request('?days=1&symbols=BTCUSDT&intervals=5m'));
    const body = await res.json();

    expect(body.missing).toBe(2);
    expect(body.errors).toBe(0);
    expect(body.written).toBe(0);
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it('one bad file does not abandon the rest of the window', async () => {
    mockFetchArchiveFile.mockImplementation(
      ({ symbol, dataset }: { symbol: string; dataset: string }) =>
        symbol === 'ETHUSDT'
          ? Promise.reject(new Error('archive exploded'))
          : Promise.resolve(klineCsv(dataset === 'klines' ? 100 : 0.0004, BAR_TS))
    );

    const res = await GET(request('?days=1&symbols=BTCUSDT,ETHUSDT&intervals=5m'));
    const body = await res.json();

    // ETHUSDT has two series, so two files fail, and the run carries on.
    expect(body.errors).toBe(2);
    expect(body.written).toBeGreaterThan(0);
    expect(mockFetchArchiveFile).toHaveBeenCalledTimes(4);
    // The last symbol was still reached.
    expect(specs()[specs().length - 1].symbol).toBe('ETHUSDT');
  });

  it('never writes a bar from outside the requested window', async () => {
    // The window is expressed in DAYS, so its files must be days. A monthly
    // file fetched under a day window would write a whole month of bars.
    await GET(request('?days=2&symbols=BTCUSDT&intervals=1d'));
    const dates = new Set(specs().map((spec) => spec.date as string));
    expect(dates.size).toBe(2);
    for (const date of dates) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('honours --to so a window older than the day cap can be reached', async () => {
    const res = await GET(request('?to=2026-09-06&days=2&symbols=BTCUSDT&intervals=1d'));
    const body = await res.json();
    expect(body.from).toBe('2026-09-05');
    expect(body.to).toBe('2026-09-06');
  });

  it('rejects a --to that is today or later, or malformed, or before coverage', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);

    for (const bad of [today, tomorrow]) {
      const res = await GET(request(`?to=${bad}`));
      expect(res.status).toBe(400);
    }
    expect((await GET(request('?to=2026-9-6'))).status).toBe(400);
    expect((await GET(request('?to=2019-01-01'))).status).toBe(400);
    expect(mockFetchArchiveFile).not.toHaveBeenCalled();
  });

  it('caps days, falls back on nonsense, and validates series and intervals', async () => {
    const capped = await GET(request('?days=90&symbols=BTCUSDT&intervals=1d'));
    expect((await capped.json()).days).toBe(7);

    const fallback = await GET(request('?days=abc&symbols=BTCUSDT&intervals=1d'));
    expect((await fallback.json()).days).toBe(3);

    expect((await GET(request('?series=funding'))).status).toBe(400);
    expect((await GET(request('?intervals=2h'))).status).toBe(400);
  });

  it('excludes markPrice by default and accepts it when asked', async () => {
    await GET(request('?days=1&symbols=BTCUSDT&intervals=1d'));
    expect(specs().every((spec) => spec.dataset !== 'markPrice')).toBe(true);

    mockFetchArchiveFile.mockClear();
    const res = await GET(request('?days=1&symbols=BTCUSDT&intervals=1d&series=markPrice'));
    const body = await res.json();
    expect(body.series).toEqual(['markPrice']);
    expect(specs().map((spec) => spec.dataset)).toEqual(['markPrice']);
  });

  it('refuses a symbol that is not a symbol, before building any path', async () => {
    // `symbols` is the one parameter not drawn from a fixed set, and it reaches
    // the archive URL and, if a cache dir is ever wired in, the cache path. A
    // traversal attempt must be refused on shape.
    for (const bad of ['../../etc/passwd', 'BTC/USDT', '..%2FBTCUSDT', 'BTC', 'BTC USDT']) {
      const res = await GET(request(`?symbols=${encodeURIComponent(bad)}`));
      expect(res.status, bad).toBe(400);
    }
    expect(mockFetchArchiveFile).not.toHaveBeenCalled();
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it('accepts every symbol the signal set actually uses', async () => {
    const res = await GET(request('?days=1&symbols=BTCUSDT,ETHUSDT,DOGEUSDT&intervals=1d&series=klines'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.symbols).toBe(3);
    expect(body.fetched).toBe(3);
  });

  it('a narrowed run fetches proportionally less', async () => {
    const res = await GET(request('?days=1&symbols=BTCUSDT&intervals=1d&series=klines'));
    const body = await res.json();
    expect(body.fetched).toBe(1);
    expect(mockFetchArchiveFile).toHaveBeenCalledTimes(1);
  });
});
