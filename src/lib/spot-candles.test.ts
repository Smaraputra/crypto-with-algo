// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockBulkWrite } = vi.hoisted(() => ({ mockBulkWrite: vi.fn() }));

vi.mock('@/lib/models/candle', () => ({
  Candle: { bulkWrite: (...args: unknown[]) => mockBulkWrite(...args) },
}));

import { SPOT_WRITE_CHUNK, bulkInsertSpotCandles, spotCandleInserts, type SpotCandleInsert } from './spot-candles';
import type { KlineCsvRow } from '@/lib/external/binance-archive';

function makeRows(count: number): KlineCsvRow[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: i * 3600000,
    open: 100 + i,
    high: 110 + i,
    low: 90 + i,
    close: 105 + i,
    volume: 1000 + i,
    quoteVolume: 100000 + i,
    trades: 50 + i,
    takerBuyVolume: 500 + i,
  }));
}

function makeOps(count: number): SpotCandleInsert[] {
  return spotCandleInserts('BTCUSDT', '1h', makeRows(count));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBulkWrite.mockResolvedValue({ upsertedCount: 2, modifiedCount: 1 });
});

describe('spotCandleInserts', () => {
  it('maps OHLCV and takerBuyVolume, and never includes expiresAt', () => {
    const rows: KlineCsvRow[] = [
      {
        timestamp: 1500000000000,
        open: 100,
        high: 110,
        low: 90,
        close: 105,
        volume: 1000,
        quoteVolume: 100000,
        trades: 50,
        takerBuyVolume: 400,
      },
    ];
    const ops = spotCandleInserts('BTCUSDT', '1h', rows);
    expect(ops).toHaveLength(1);
    expect(ops[0].filter).toEqual({
      symbol: 'BTCUSDT',
      interval: '1h',
      timestamp: 1500000000000,
    });
    expect(ops[0].insert).toEqual({
      symbol: 'BTCUSDT',
      interval: '1h',
      timestamp: 1500000000000,
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 1000,
      takerBuyVolume: 400,
    });
    expect('expiresAt' in ops[0].insert).toBe(false);
  });

  it('omits takerBuyVolume when null or NaN', () => {
    const rows: KlineCsvRow[] = [
      {
        timestamp: 1500000000000,
        open: 100,
        high: 110,
        low: 90,
        close: 105,
        volume: 1000,
        quoteVolume: 100000,
        trades: 50,
        takerBuyVolume: null,
      },
      {
        timestamp: 1500003600000,
        open: 105,
        high: 115,
        low: 95,
        close: 110,
        volume: 2000,
        quoteVolume: 200000,
        trades: 60,
        takerBuyVolume: Number.NaN,
      },
    ];
    const ops = spotCandleInserts('BTCUSDT', '1h', rows);
    expect(ops).toHaveLength(2);
    expect('takerBuyVolume' in ops[0].insert).toBe(false);
    expect('takerBuyVolume' in ops[1].insert).toBe(false);
    expect('expiresAt' in ops[0].insert).toBe(false);
    expect('expiresAt' in ops[1].insert).toBe(false);
  });
});

describe('bulkInsertSpotCandles', () => {
  it('chunks at SPOT_WRITE_CHUNK, uses ordered false, and returns summed upsertedCount ignoring modifiedCount', async () => {
    const ops = makeOps(SPOT_WRITE_CHUNK * 2 + 1);
    mockBulkWrite.mockResolvedValue({ upsertedCount: 2, modifiedCount: 5 });

    const written = await bulkInsertSpotCandles(ops);

    expect(mockBulkWrite).toHaveBeenCalledTimes(3);
    const sizes = mockBulkWrite.mock.calls.map((call) => (call[0] as unknown[]).length);
    expect(sizes).toEqual([SPOT_WRITE_CHUNK, SPOT_WRITE_CHUNK, 1]);
    // 2 upserted per chunk x 3 chunks = 6, modifiedCount is ignored
    expect(written).toBe(6);
  });

  it('sends updateOne with $setOnInsert (and NO $set) and upsert true', async () => {
    const ops = makeOps(1);
    await bulkInsertSpotCandles(ops);

    expect(mockBulkWrite).toHaveBeenCalledTimes(1);
    const [entries, options] = mockBulkWrite.mock.calls[0] as [Array<{ updateOne: Record<string, unknown> }>, unknown];
    expect(options).toEqual({ ordered: false });
    expect(entries[0]).toEqual({
      updateOne: {
        filter: ops[0].filter,
        update: { $setOnInsert: ops[0].insert },
        upsert: true,
      },
    });
    const updateObj = entries[0].updateOne.update as Record<string, unknown>;
    expect(updateObj.$set).toBeUndefined();
  });

  it('makes no call and returns 0 for zero ops', async () => {
    const written = await bulkInsertSpotCandles([]);
    expect(written).toBe(0);
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });
});
