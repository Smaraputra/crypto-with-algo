// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/candle-ingestion', () => ({
  backfillCandles: vi.fn(),
  getCandleRange: vi.fn(),
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { backfillCandles, getCandleRange } from '@/lib/candle-ingestion';

const mockSession = { user: { id: 'user-1' } };

function makePostRequest(body: unknown, secret?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers.authorization = `Bearer ${secret}`;
  return new NextRequest('http://localhost/api/candles/backfill', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/candles/backfill', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makePostRequest({ symbol: 'BTCUSDT', interval: '1h' }));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('accepts cron secret as authentication', async () => {
    vi.stubEnv('CRON_SECRET', 'test-cron-secret');
    vi.mocked(backfillCandles).mockResolvedValue({ inserted: 100 } as never);
    vi.mocked(getCandleRange).mockResolvedValue({
      count: 500, oldest: 1000000, newest: 2000000,
    } as never);

    const res = await POST(makePostRequest({ symbol: 'BTCUSDT', interval: '1d', months: 60 }, 'test-cron-secret'));
    expect(res.status).toBe(200);
    expect(auth).not.toHaveBeenCalled();
    expect(backfillCandles).toHaveBeenCalledWith('BTCUSDT', '1d', 60);
  });

  it('returns 400 for invalid JSON', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await POST(
      new NextRequest('http://localhost/api/candles/backfill', {
        method: 'POST',
        body: 'invalid json',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Invalid JSON');
  });

  it('returns 400 for missing symbol', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await POST(makePostRequest({ interval: '1h' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 for missing interval', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await POST(makePostRequest({ symbol: 'BTCUSDT' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 for invalid interval', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await POST(makePostRequest({ symbol: 'BTCUSDT', interval: 'invalid' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 for months less than 1', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await POST(makePostRequest({ symbol: 'BTCUSDT', interval: '1h', months: 0 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('1');
  });

  it('returns 400 for months greater than 60', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await POST(makePostRequest({ symbol: 'BTCUSDT', interval: '1h', months: 72 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('60');
  });

  it('uses default months of 24 when not specified', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(backfillCandles).mockResolvedValue({ inserted: 1000 } as never);
    vi.mocked(getCandleRange).mockResolvedValue({
      count: 2000,
      oldest: 1000000,
      newest: 2000000,
    } as never);

    await POST(makePostRequest({ symbol: 'BTCUSDT', interval: '1h' }));
    expect(backfillCandles).toHaveBeenCalledWith('BTCUSDT', '1h', 24);
  });

  it('backfills successfully and returns stats', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(backfillCandles).mockResolvedValue({ inserted: 500 } as never);
    vi.mocked(getCandleRange).mockResolvedValue({
      count: 1500,
      oldest: 1000000,
      newest: 2000000,
    } as never);

    const res = await POST(makePostRequest({ symbol: 'BTCUSDT', interval: '1h', months: 6 }));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.inserted).toBe(500);
    expect(data.total).toBe(1500);
    expect(data.oldest).toBe(1000000);
    expect(data.newest).toBe(2000000);

    expect(backfillCandles).toHaveBeenCalledWith('BTCUSDT', '1h', 6);
    expect(getCandleRange).toHaveBeenCalledWith('BTCUSDT', '1h');
  });

  it('returns 500 when backfillCandles throws', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(backfillCandles).mockRejectedValue(new Error('Binance API rate limit exceeded'));

    const res = await POST(makePostRequest({ symbol: 'BTCUSDT', interval: '1h' }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Backfill failed');
  });

  it('returns 500 when getCandleRange throws', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(backfillCandles).mockResolvedValue({ inserted: 100 } as never);
    vi.mocked(getCandleRange).mockRejectedValue(new Error('Database error'));

    const res = await POST(makePostRequest({ symbol: 'BTCUSDT', interval: '1h' }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Backfill failed');
  });

  it('returns 500 with generic message for unknown errors', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(backfillCandles).mockRejectedValue('Unknown error');

    const res = await POST(makePostRequest({ symbol: 'BTCUSDT', interval: '1h' }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Backfill failed');
  });

  it('handles zero insertions (data already exists)', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(backfillCandles).mockResolvedValue({ inserted: 0 } as never);
    vi.mocked(getCandleRange).mockResolvedValue({
      count: 5000,
      oldest: 1000000,
      newest: 2000000,
    } as never);

    const res = await POST(makePostRequest({ symbol: 'BTCUSDT', interval: '1h', months: 3 }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.inserted).toBe(0);
    expect(data.total).toBe(5000);
  });
});
