// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockFetchArchiveFile, mockBulkWrite } = vi.hoisted(() => ({
  mockFetchArchiveFile: vi.fn(),
  mockBulkWrite: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

// withJobRun upserts a heartbeat after the handler returns. Mock the MODEL and
// not the wrapper, so the wrapper's real logic still runs here. Without this,
// mongoose buffers the write against an unconnected client and the test hangs.
vi.mock('@/lib/models/job-heartbeat', () => ({
  JobHeartbeat: { updateOne: vi.fn() },
}));

vi.mock('@/lib/models/futures-metric', () => ({
  FuturesMetric: { bulkWrite: (...args: unknown[]) => mockBulkWrite(...args) },
}));

vi.mock('@/lib/external/binance-archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/external/binance-archive')>(
    '@/lib/external/binance-archive'
  );
  return { ...actual, fetchArchiveFile: (...args: unknown[]) => mockFetchArchiveFile(...args) };
});

import { GET } from './route';

const SECRET = 'test-cron-secret';

const METRICS_CSV =
  'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio\n' +
  '2024-01-01 00:00:00,BTCUSDT,100,1000000,1.2,1.5,2,0.9\n' +
  '2024-01-01 00:05:00,BTCUSDT,101,1010000,1.3,1.6,2.1,1.1\n';

const DEPTH_CSV =
  'timestamp,percentage,depth,notional\n' +
  '2024-01-01 00:00:10,-1,1,100\n' +
  '2024-01-01 00:00:10,1,3,300\n';

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/cron/ingest-archive${query}`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  mockBulkWrite.mockResolvedValue({ upsertedCount: 2, modifiedCount: 0 });
  mockFetchArchiveFile.mockImplementation(({ dataset }: { dataset: string }) =>
    Promise.resolve(dataset === 'metrics' ? METRICS_CSV : DEPTH_CSV)
  );
});

describe('GET /api/cron/ingest-archive', () => {
  it('rejects a request with no bearer secret', async () => {
    const res = await GET(new NextRequest('http://localhost:3000/api/cron/ingest-archive'));
    expect(res.status).toBe(401);
    expect(mockFetchArchiveFile).not.toHaveBeenCalled();
  });

  it('ingests the default three-day window for every signal symbol', async () => {
    const res = await GET(request());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.days).toBe(3);
    expect(body.symbols).toBe(10);
    expect(body.errors).toBe(0);
    expect(body.written).toBeGreaterThan(0);
  });

  it('never asks for today, whose archive file does not exist yet', async () => {
    const body = await (await GET(request())).json();
    const today = new Date().toISOString().slice(0, 10);
    expect(body.to).not.toBe(today);
    const asked = mockFetchArchiveFile.mock.calls.map((c) => c[0].date);
    expect(asked).not.toContain(today);
  });

  it('honours an explicit symbol list and day count', async () => {
    const body = await (await GET(request('?symbols=BTCUSDT&days=1'))).json();
    expect(body.symbols).toBe(1);
    expect(body.days).toBe(1);
    expect(body.from).toBe(body.to);
    // One metrics file and one bookDepth file for one symbol-day.
    expect(mockFetchArchiveFile).toHaveBeenCalledTimes(2);
  });

  it('caps the window so a cron run cannot ask for an unbounded backfill', async () => {
    const body = await (await GET(request('?symbols=BTCUSDT&days=90'))).json();
    expect(body.days).toBe(7);
  });

  it('falls back to the default for a nonsense day count', async () => {
    const body = await (await GET(request('?symbols=BTCUSDT&days=abc'))).json();
    expect(body.days).toBe(3);
  });

  it('skips the depth pass when asked', async () => {
    await GET(request('?symbols=BTCUSDT&days=1&depth=false'));
    const datasets = mockFetchArchiveFile.mock.calls.map((c) => c[0].dataset);
    expect(datasets).toEqual(['metrics']);
  });

  it('writes metrics and depth into the same collection', async () => {
    await GET(request('?symbols=BTCUSDT&days=1'));
    expect(mockBulkWrite).toHaveBeenCalledTimes(2);
    const metricsOps = mockBulkWrite.mock.calls[0][0];
    expect(metricsOps[0].updateOne.filter).toEqual({
      symbol: 'BTCUSDT',
      timestamp: Date.UTC(2024, 0, 1),
    });
    expect(metricsOps[0].updateOne.update.$set.openInterest).toBe(100);
    const depthOps = mockBulkWrite.mock.calls[1][0];
    expect(depthOps[0].updateOne.update.$set.depthImbalance1).toBeCloseTo(-0.5, 10);
  });

  it('counts a missing archive day without failing', async () => {
    mockFetchArchiveFile.mockResolvedValue(null);
    const body = await (await GET(request('?symbols=BTCUSDT&days=1'))).json();
    expect(body.missing).toBe(2);
    expect(body.errors).toBe(0);
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it('counts a failure and keeps going through the window', async () => {
    mockFetchArchiveFile
      .mockRejectedValueOnce(new Error('archive unreachable'))
      .mockResolvedValue(METRICS_CSV);
    const body = await (await GET(request('?symbols=BTCUSDT&days=2'))).json();
    expect(body.errors).toBe(1);
    expect(body.written).toBeGreaterThan(0);
  });
});
