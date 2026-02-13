// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/candle-ingestion', () => ({
  getCandles: vi.fn(),
  backfillCandles: vi.fn(),
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { getCandles, backfillCandles } from '@/lib/candle-ingestion';

const mockSession = { user: { id: 'user-1' } };

function makeGetRequest(params?: string): NextRequest {
  const url = params
    ? `http://localhost/api/candles?${params}`
    : 'http://localhost/api/candles';
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/candles', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeGetRequest('symbol=BTCUSDT&interval=1h'));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 for missing symbol', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await GET(makeGetRequest('interval=1h'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 for invalid interval', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await GET(makeGetRequest('symbol=BTCUSDT&interval=999h'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 for limit exceeding 50000', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await GET(makeGetRequest('symbol=BTCUSDT&interval=1h&limit=60000'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('50000');
  });

  it('fetches candles successfully with minimal params', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockCandles = [
      { timestamp: 1000, open: 40000, high: 40100, low: 39900, close: 40050, volume: 100 },
      { timestamp: 2000, open: 40050, high: 40200, low: 40000, close: 40150, volume: 150 },
    ];
    vi.mocked(getCandles).mockResolvedValue(mockCandles as never);

    const res = await GET(makeGetRequest('symbol=BTCUSDT&interval=1h'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.candles).toEqual(mockCandles);
    expect(data.count).toBe(2);
  });

  it('uses default limit of 500 when not specified', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(getCandles).mockResolvedValue([] as never);

    await GET(makeGetRequest('symbol=BTCUSDT&interval=1h'));
    expect(getCandles).toHaveBeenCalledWith('BTCUSDT', '1h', undefined, undefined, 500);
  });

  it('passes startTime, endTime, and custom limit to getCandles', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(getCandles).mockResolvedValue([] as never);

    await GET(
      makeGetRequest('symbol=BTCUSDT&interval=1h&startTime=1000&endTime=2000&limit=100')
    );
    expect(getCandles).toHaveBeenCalledWith('BTCUSDT', '1h', 1000, 2000, 100);
  });

  it('triggers backfill when insufficient data and startTime provided', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    // First call returns insufficient data (< 10 candles)
    vi.mocked(getCandles)
      .mockResolvedValueOnce([{ timestamp: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 }] as never)
      .mockResolvedValueOnce(Array(20).fill({}) as never);

    vi.mocked(backfillCandles).mockResolvedValue({ inserted: 100 } as never);

    const threeMonthsAgo = Date.now() - 3 * 30 * 24 * 60 * 60 * 1000;
    await GET(makeGetRequest(`symbol=BTCUSDT&interval=1h&startTime=${threeMonthsAgo}`));

    expect(backfillCandles).toHaveBeenCalled();
    expect(getCandles).toHaveBeenCalledTimes(2);
  });

  it('does not trigger backfill when no startTime provided', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(getCandles).mockResolvedValue([{ timestamp: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 }] as never);

    await GET(makeGetRequest('symbol=BTCUSDT&interval=1h'));

    expect(backfillCandles).not.toHaveBeenCalled();
    expect(getCandles).toHaveBeenCalledTimes(1);
  });

  it('does not trigger backfill when sufficient data exists', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockCandles = Array(50).fill({ timestamp: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    vi.mocked(getCandles).mockResolvedValue(mockCandles as never);

    const threeMonthsAgo = Date.now() - 3 * 30 * 24 * 60 * 60 * 1000;
    await GET(makeGetRequest(`symbol=BTCUSDT&interval=1h&startTime=${threeMonthsAgo}`));

    expect(backfillCandles).not.toHaveBeenCalled();
    expect(getCandles).toHaveBeenCalledTimes(1);
  });

  it('caps backfill months at 24', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(getCandles)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(backfillCandles).mockResolvedValue({ inserted: 0 } as never);

    const threeYearsAgo = Date.now() - 36 * 30 * 24 * 60 * 60 * 1000;
    await GET(makeGetRequest(`symbol=BTCUSDT&interval=1h&startTime=${threeYearsAgo}`));

    expect(backfillCandles).toHaveBeenCalledWith('BTCUSDT', '1h', 24);
  });

  it('returns 500 when getCandles throws', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(getCandles).mockRejectedValue(new Error('Database connection failed'));

    const res = await GET(makeGetRequest('symbol=BTCUSDT&interval=1h'));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Database connection failed');
  });

  it('returns 500 with generic message for unknown errors', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(getCandles).mockRejectedValue('Unknown error');

    const res = await GET(makeGetRequest('symbol=BTCUSDT&interval=1h'));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Failed to fetch candles');
  });
});
