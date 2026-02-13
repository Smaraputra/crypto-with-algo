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
    find: vi.fn(),
    countDocuments: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('@/lib/models/strategy', () => ({
  Strategy: {
    findOne: vi.fn(),
  },
}));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { BacktestResultV2 } from '@/lib/models/backtest-result-v2';

const mockSession = { user: { id: 'user-1' } };

const mockSaveInput = {
  symbol: 'BTCUSDT',
  interval: '1h',
  config: { entryThreshold: 30 },
  metrics: { totalPnl: 500 },
  trades: [{ entryPrice: 42000, exitPrice: 43000 }],
  equityCurve: [{ bar: 0, equity: 10000 }],
  totalBars: 500,
  warmupBars: 200,
  startTime: 1704067200000,
  endTime: 1704153600000,
};

function makeGetRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/backtests${query}`, {
    method: 'GET',
  });
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/backtests', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/backtests', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('returns backtest results for user', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(BacktestResultV2.find).mockReturnValue({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ _id: 'bt1', symbol: 'BTCUSDT' }]),
        }),
      }),
    } as never);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toHaveLength(1);
  });
});

describe('POST /api/backtests', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makePostRequest(mockSaveInput));
    expect(res.status).toBe(401);
  });

  it('saves a backtest result', async () => {
    const { Strategy } = await import('@/lib/models/strategy');

    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Strategy.findOne).mockResolvedValue(null);
    vi.mocked(BacktestResultV2.create).mockResolvedValue({
      _id: 'bt1',
      userId: 'user-1',
      ...mockSaveInput,
    } as never);

    const res = await POST(makePostRequest(mockSaveInput));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.result.symbol).toBe('BTCUSDT');
  });

  it('returns 400 for invalid input', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await POST(makePostRequest({ symbol: '' }));
    expect(res.status).toBe(400);
  });
});
