// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';


vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

// withJobRun upserts a heartbeat after the handler returns. Mock the MODEL and
// not the wrapper, so the wrapper's real logic still runs here. Without this,
// mongoose buffers the write against an unconnected client and the test hangs.
vi.mock('@/lib/models/job-heartbeat', () => ({
  JobHeartbeat: { updateOne: vi.fn() },
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
}));

vi.mock('@/lib/binance', () => ({
  fetchKlines: vi.fn(),
}));

const mockGetCandles = vi.fn();
// dropOpenBars is pure (no DB/IO), so keep the real implementation while
// getCandles stays fully mocked -- lets one test exercise the real
// cachedFetch producer (getCandles -> fetchKlines fallback -> dropOpenBars).
vi.mock('@/lib/candle-ingestion', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/candle-ingestion')>('@/lib/candle-ingestion');
  return {
    dropOpenBars: actual.dropOpenBars,
    getCandles: (...args: unknown[]) => mockGetCandles(...args),
  };
});

vi.mock('@/lib/binance-futures', () => ({
  fetchFundingRate: vi.fn(),
  fetchLongShortRatio: vi.fn(),
}));

vi.mock('@/lib/external/fear-greed', () => ({
  fetchFearAndGreed: vi.fn().mockResolvedValue({
    fearGreedIndex: 50,
    label: 'Neutral',
  }),
}));

vi.mock('@/lib/models/signal', () => ({
  Signal: {
    create: vi.fn().mockResolvedValue({ _id: 'signal-1' }),
  },
}));

vi.mock('@/lib/models/strategy', () => ({
  Strategy: {
    find: vi.fn(),
  },
}));

const mockComputeSignalBatch = vi.fn();
const mockBuildTasksForStyle = vi.fn();

vi.mock('@/lib/signals/compute-engine', () => ({
  computeSignalBatch: (...args: unknown[]) => mockComputeSignalBatch(...args),
  buildTasksForStyle: (...args: unknown[]) => mockBuildTasksForStyle(...args),
}));

vi.mock('@/lib/signals/signal-symbols', () => ({
  SIGNAL_SYMBOLS: ['BTCUSDT', 'ETHUSDT'],
}));

// computeAllIndicators is real (candle-ingestion isn't mocked in this file
// either), wrapped only so tests can inspect what candles it was called with.
vi.mock('@/lib/indicators/compute', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/indicators/compute')>('@/lib/indicators/compute');
  return { ...actual, computeAllIndicators: vi.fn(actual.computeAllIndicators) };
});

import { GET } from './route';

function makeRequest(secret?: string, params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/cron/compute-signals');
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

describe('GET /api/cron/compute-signals', () => {
  it('returns 401 without cron secret', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong secret', async () => {
    const res = await GET(makeRequest('wrong'));
    expect(res.status).toBe(401);
  });

});

describe('GET /api/cron/compute-signals?style=', () => {
  it('returns 400 for invalid trading style', async () => {
    const res = await GET(makeRequest('test-secret', { style: 'invalid_style' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Invalid trading style');
  });

  it('calls computeSignalBatch for valid style', async () => {
    const mockTasks = [
      { symbol: 'BTCUSDT', interval: '15m', tradingStyle: 'day_trading' },
      { symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'day_trading' },
      { symbol: 'ETHUSDT', interval: '15m', tradingStyle: 'day_trading' },
      { symbol: 'ETHUSDT', interval: '1h', tradingStyle: 'day_trading' },
    ];
    mockBuildTasksForStyle.mockReturnValue(mockTasks);
    mockComputeSignalBatch.mockResolvedValue({
      computed: 4,
      errors: 0,
      skipped: 0,
      details: [],
    });

    const res = await GET(makeRequest('test-secret', { style: 'day_trading' }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.mode).toBe('global');
    expect(data.style).toBe('day_trading');
    expect(data.computed).toBe(4);
    expect(data.errors).toBe(0);
    expect(data.tasks).toBe(4);

    expect(mockBuildTasksForStyle).toHaveBeenCalledWith('day_trading', ['BTCUSDT', 'ETHUSDT']);
    expect(mockComputeSignalBatch).toHaveBeenCalledWith(mockTasks);
  });

  it('returns mode:global for scalping style', async () => {
    mockBuildTasksForStyle.mockReturnValue([]);
    mockComputeSignalBatch.mockResolvedValue({
      computed: 0,
      errors: 0,
      skipped: 0,
      details: [],
    });

    const res = await GET(makeRequest('test-secret', { style: 'scalping' }));
    const data = await res.json();
    expect(data.mode).toBe('global');
    expect(data.style).toBe('scalping');
  });

  it('returns mode:global for position_trading style', async () => {
    mockBuildTasksForStyle.mockReturnValue([
      { symbol: 'BTCUSDT', interval: '1d', tradingStyle: 'position_trading' },
    ]);
    mockComputeSignalBatch.mockResolvedValue({
      computed: 1,
      errors: 0,
      skipped: 0,
      details: [],
    });

    const res = await GET(makeRequest('test-secret', { style: 'position_trading' }));
    const data = await res.json();
    expect(data.mode).toBe('global');
    expect(data.style).toBe('position_trading');
    expect(data.computed).toBe(1);
  });

  it('reports errors from compute batch', async () => {
    mockBuildTasksForStyle.mockReturnValue([
      { symbol: 'BTCUSDT', interval: '1m', tradingStyle: 'scalping' },
    ]);
    mockComputeSignalBatch.mockResolvedValue({
      computed: 0,
      errors: 1,
      skipped: 0,
      details: [
        { symbol: 'BTCUSDT', interval: '1m', tradingStyle: 'scalping', status: 'error', error: 'API error' },
      ],
    });

    const res = await GET(makeRequest('test-secret', { style: 'scalping' }));
    const data = await res.json();
    expect(data.errors).toBe(1);
    expect(data.computed).toBe(0);
  });

  it('refuses a run with no style instead of scoring each user\'s own strategies', async () => {
    // Omitting `style` used to run computeLegacySignals(): a third scorer on
    // DEFAULT_CONFIG periods, DEFAULT_WEIGHTS, no HTF, no news and no
    // configVersion, writing per-user `Signal` documents nothing reads.
    const res = await GET(makeRequest('test-secret'));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Missing trading style');
    expect(mockBuildTasksForStyle).not.toHaveBeenCalled();
  });
});
