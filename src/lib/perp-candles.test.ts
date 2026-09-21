// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockBulkWrite } = vi.hoisted(() => ({ mockBulkWrite: vi.fn() }));

vi.mock('@/lib/models/perp-candle', () => ({
  PerpCandle: { bulkWrite: (...args: unknown[]) => mockBulkWrite(...args) },
}));

import { PERP_WRITE_CHUNK, bulkUpsertPerpCandles } from './perp-candles';
import type { PerpCandleFields, UpsertOp } from './archive-ingestion';

function ops(count: number): UpsertOp<PerpCandleFields>[] {
  return Array.from({ length: count }, (_, i) => ({
    filter: { symbol: 'BTCUSDT', interval: '5m', series: 'klines', timestamp: i },
    set: {
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
      quoteVolume: 15,
      trades: 3,
    },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBulkWrite.mockResolvedValue({ upsertedCount: 2, modifiedCount: 1 });
});

describe('bulkUpsertPerpCandles', () => {
  it('chunks the writes and sums the reported counts', async () => {
    const written = await bulkUpsertPerpCandles(ops(PERP_WRITE_CHUNK * 2 + 1));

    expect(mockBulkWrite).toHaveBeenCalledTimes(3);
    const sizes = mockBulkWrite.mock.calls.map((call) => (call[0] as unknown[]).length);
    expect(sizes).toEqual([PERP_WRITE_CHUNK, PERP_WRITE_CHUNK, 1]);

    // upsertedCount 2 + modifiedCount 1 per chunk, three chunks.
    expect(written).toBe(9);
  });

  it('writes idempotent upserts with ordered false', async () => {
    await bulkUpsertPerpCandles(ops(1));
    const [entries, options] = mockBulkWrite.mock.calls[0] as [Record<string, unknown>[], unknown];
    expect(options).toEqual({ ordered: false });
    expect(entries[0]).toEqual({
      updateOne: {
        filter: { symbol: 'BTCUSDT', interval: '5m', series: 'klines', timestamp: 0 },
        update: {
          $set: {
            open: 1,
            high: 2,
            low: 0.5,
            close: 1.5,
            volume: 10,
            quoteVolume: 15,
            trades: 3,
          },
        },
        upsert: true,
      },
    });
  });

  it('does not call bulkWrite for an empty op list', async () => {
    expect(await bulkUpsertPerpCandles([])).toBe(0);
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it('treats a zero-count result as success, not failure', async () => {
    // A re-run over bars that are already stored reports nothing written while
    // nothing is wrong, which is why the route also reports files fetched.
    mockBulkWrite.mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 });
    expect(await bulkUpsertPerpCandles(ops(3))).toBe(0);
  });
});
