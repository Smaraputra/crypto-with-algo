// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/backtest-result-v2', () => ({
  BacktestResultV2: {
    findOne: vi.fn(),
    findOneAndDelete: vi.fn(),
  },
}));

import { GET, DELETE } from './route';
import { auth } from '@/lib/auth';
import { BacktestResultV2 } from '@/lib/models/backtest-result-v2';

const mockSession = { user: { id: 'user-1' } };
const params = Promise.resolve({ id: 'bt-1' });

function makeRequest(method: string): NextRequest {
  return new NextRequest('http://localhost/api/backtests/bt-1', { method });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/backtests/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest('GET'), { params });
    expect(res.status).toBe(401);
  });

  it('returns backtest result', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(BacktestResultV2.findOne).mockResolvedValue({
      _id: 'bt-1',
      symbol: 'BTCUSDT',
      metrics: {},
    } as never);

    const res = await GET(makeRequest('GET'), { params });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.symbol).toBe('BTCUSDT');
  });

  it('returns 404 when not found', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(BacktestResultV2.findOne).mockResolvedValue(null);

    const res = await GET(makeRequest('GET'), { params });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/backtests/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(401);
  });

  it('deletes backtest result', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(BacktestResultV2.findOneAndDelete).mockResolvedValue({ _id: 'bt-1' } as never);

    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('returns 404 when not found', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(BacktestResultV2.findOneAndDelete).mockResolvedValue(null);

    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(404);
  });
});
