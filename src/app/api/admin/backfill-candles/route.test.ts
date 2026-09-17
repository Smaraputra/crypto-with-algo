import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';

const mockConnectDB = vi.fn();
vi.mock('@/lib/mongodb', () => ({
  connectDB: () => mockConnectDB(),
}));

const mockAuth = vi.fn();
vi.mock('@/lib/auth', () => ({
  auth: () => mockAuth(),
}));

const mockBackfillCandles = vi.fn();
const mockGetCandleRange = vi.fn();
vi.mock('@/lib/candle-ingestion', () => ({
  backfillCandles: (...args: unknown[]) => mockBackfillCandles(...args),
  getCandleRange: (...args: unknown[]) => mockGetCandleRange(...args),
}));

const mockCountDocuments = vi.fn();
vi.mock('@/lib/models/candle', () => ({
  Candle: { countDocuments: (...args: unknown[]) => mockCountDocuments(...args) },
  HF_INTERVALS: ['1m'],
}));

function makeRequest(body: unknown) {
  return new Request('http://localhost:3000/api/admin/backfill-candles', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as never;
}

describe('POST /api/admin/backfill-candles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockConnectDB.mockResolvedValue(undefined);
    mockBackfillCandles.mockResolvedValue({ inserted: 0, total: 100 });
    mockGetCandleRange.mockResolvedValue({ oldest: 1, newest: 2, count: 100 });
    mockCountDocuments.mockResolvedValue(100);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ADMIN_EMAIL;
    vi.restoreAllMocks();
  });

  /** The route sleeps between pairs; drive timers while it runs. */
  async function run(body: unknown) {
    const promise = POST(makeRequest(body));
    await vi.runAllTimersAsync();
    return promise;
  }

  function asAdmin() {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
  }

  it('rejects a non-admin user', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'someone@example.com' } });

    const response = await run({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 });

    expect(response.status).toBe(401);
    expect(mockBackfillCandles).not.toHaveBeenCalled();
  });

  it('returns 500 when ADMIN_EMAIL is unconfigured', async () => {
    delete process.env.ADMIN_EMAIL;
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const response = await run({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 });
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Admin access is not configured');
  });

  it('backfills each symbol and interval pair', async () => {
    asAdmin();

    const response = await run({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      intervals: ['1h', '1d'],
      months: 12,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(mockBackfillCandles).toHaveBeenCalledTimes(4);
    expect(data.results).toHaveLength(4);
  });

  it('passes the refill flag through to the ingestion layer', async () => {
    asAdmin();

    await run({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 6, refill: true });

    expect(mockBackfillCandles).toHaveBeenCalledWith('BTCUSDT', '1h', 6, { refill: true });
  });

  it('defaults refill off, so a plain call only fills gaps', async () => {
    asAdmin();

    await run({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 6 });

    expect(mockBackfillCandles).toHaveBeenCalledWith('BTCUSDT', '1h', 6, { refill: false });
  });

  it('reports takerBuyVolume coverage, since a refill inserts nothing', async () => {
    asAdmin();
    mockBackfillCandles.mockResolvedValue({ inserted: 0, total: 500 });
    mockGetCandleRange.mockResolvedValue({ oldest: 1, newest: 2, count: 500 });
    mockCountDocuments.mockResolvedValue(500);

    const response = await run({
      symbols: ['BTCUSDT'], intervals: ['1h'], months: 6, refill: true,
    });
    const data = await response.json();

    expect(data.inserted).toBe(0);
    expect(data.results[0].withTakerVolume).toBe(500);
    expect(data.results[0].total).toBe(500);
  });

  it('rejects the TTL-backed interval that a backfill cannot retain', async () => {
    asAdmin();

    const response = await run({ symbols: ['BTCUSDT'], intervals: ['1m'], months: 6 });

    expect(response.status).toBe(400);
    expect(mockBackfillCandles).not.toHaveBeenCalled();
  });

  it('accepts 5m, since it is now durable', async () => {
    asAdmin();

    const response = await run({ symbols: ['BTCUSDT'], intervals: ['5m'], months: 6 });

    expect(response.status).toBe(200);
    expect(mockBackfillCandles).toHaveBeenCalledWith('BTCUSDT', '5m', 6, { refill: false });
  });

  it('names the excluded intervals in the response', async () => {
    asAdmin();

    const response = await run({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 6 });
    const data = await response.json();

    expect(data.excludedIntervals).toEqual(['1m']);
  });

  it('accepts a 120-month window and rejects a longer one', async () => {
    asAdmin();

    expect((await run({ symbols: ['BTCUSDT'], intervals: ['1d'], months: 120 })).status).toBe(200);
    expect((await run({ symbols: ['BTCUSDT'], intervals: ['1d'], months: 130 })).status).toBe(400);
  });

  it('accepts a 5m backfill up to 12 months and rejects a longer one', async () => {
    asAdmin();

    expect((await run({ symbols: ['BTCUSDT'], intervals: ['5m'], months: 12 })).status).toBe(200);
    expect((await run({ symbols: ['BTCUSDT'], intervals: ['5m'], months: 13 })).status).toBe(400);
  });

  it('caps a mixed request at 12 months when 15m is included', async () => {
    asAdmin();

    const response = await run({
      symbols: ['BTCUSDT'], intervals: ['15m', '1h'], months: 13,
    });

    expect(response.status).toBe(400);
  });

  it('rejects an empty interval list', async () => {
    asAdmin();

    const response = await run({ symbols: ['BTCUSDT'], intervals: [], months: 6 });

    expect(response.status).toBe(400);
  });

  it('counts a failing pair as an error and continues with the rest', async () => {
    asAdmin();
    mockBackfillCandles
      .mockRejectedValueOnce(new Error('Binance 418'))
      .mockResolvedValue({ inserted: 5, total: 105 });

    const response = await run({
      symbols: ['BTCUSDT', 'ETHUSDT'], intervals: ['1h'], months: 6,
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.errors).toBe(1);
    expect(data.results).toHaveLength(1);
  });

  it('returns 500 on a malformed body', async () => {
    asAdmin();

    const request = new Request('http://localhost:3000/api/admin/backfill-candles', {
      method: 'POST',
      body: 'not json',
    }) as never;

    const promise = POST(request);
    await vi.runAllTimersAsync();
    const response = await promise;

    expect(response.status).toBe(500);
  });
});
