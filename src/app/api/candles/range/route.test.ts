// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/candle-ingestion', () => ({
  getCandleRange: vi.fn(),
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { getCandleRange } from '@/lib/candle-ingestion';

const mockSession = { user: { id: 'user-1' } };

function makeGetRequest(params?: string): NextRequest {
  const url = params
    ? `http://localhost/api/candles/range?${params}`
    : 'http://localhost/api/candles/range';
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/candles/range', () => {
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

  it('returns 400 for missing interval', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await GET(makeGetRequest('symbol=BTCUSDT'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 400 for invalid interval', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await GET(makeGetRequest('symbol=BTCUSDT&interval=999h'));
    expect(res.status).toBe(400);
  });

  it('returns range info for valid params', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(getCandleRange).mockResolvedValue({
      oldest: 1600000000000,
      newest: 1700000000000,
      count: 17520,
    });

    const res = await GET(makeGetRequest('symbol=BTCUSDT&interval=1h'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      oldest: 1600000000000,
      newest: 1700000000000,
      count: 17520,
    });
    expect(getCandleRange).toHaveBeenCalledWith('BTCUSDT', '1h');
  });

  it('returns range with null values when no data', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(getCandleRange).mockResolvedValue({
      oldest: null,
      newest: null,
      count: 0,
    });

    const res = await GET(makeGetRequest('symbol=BTCUSDT&interval=1h'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(0);
    expect(data.oldest).toBeNull();
    expect(data.newest).toBeNull();
  });

  it('returns 500 when getCandleRange throws', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(getCandleRange).mockRejectedValue(new Error('DB error'));

    const res = await GET(makeGetRequest('symbol=BTCUSDT&interval=1h'));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('DB error');
  });
});
