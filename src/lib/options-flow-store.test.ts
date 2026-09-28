// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockBulkWrite } = vi.hoisted(() => ({ mockBulkWrite: vi.fn() }));

vi.mock('@/lib/models/options-flow-hour', () => ({
  OptionsFlowHour: { bulkWrite: (...args: unknown[]) => mockBulkWrite(...args) },
}));

import { bulkUpsertOptionsFlow } from './options-flow-store';
import type { UpsertOp } from './archive-ingestion';
import type { DvolFields, OptionsFlowHourFields } from './options-flow';

function ops(count: number): UpsertOp<Partial<OptionsFlowHourFields & DvolFields>>[] {
  return Array.from({ length: count }, (_, i) => ({
    filter: { currency: 'BTC', timestamp: i },
    set: {
      callBuyNotional: 1,
      callSellNotional: 2,
      putBuyNotional: 3,
      putSellNotional: 4,
      netDelta: 0.1,
      netDollarGamma: 0.2,
      tradeCount: 5,
      greekTradeCount: 4,
      vwIv: 60,
      putIv25: 61,
      callIv25: 62,
    },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBulkWrite.mockResolvedValue({ upsertedCount: 2, modifiedCount: 1 });
});

describe('bulkUpsertOptionsFlow', () => {
  it('chunks the writes at the given size and sums the reported counts', async () => {
    const written = await bulkUpsertOptionsFlow(ops(5), 2);

    expect(mockBulkWrite).toHaveBeenCalledTimes(3);
    const sizes = mockBulkWrite.mock.calls.map((call) => (call[0] as unknown[]).length);
    expect(sizes).toEqual([2, 2, 1]);
    // upsertedCount 2 + modifiedCount 1 per chunk, three chunks.
    expect(written).toBe(9);
  });

  it('chunks at 5000 by default', async () => {
    await bulkUpsertOptionsFlow(ops(5001));
    expect(mockBulkWrite).toHaveBeenCalledTimes(2);
    const sizes = mockBulkWrite.mock.calls.map((call) => (call[0] as unknown[]).length);
    expect(sizes).toEqual([5000, 1]);
  });

  it('writes idempotent upserts with ordered false', async () => {
    await bulkUpsertOptionsFlow(ops(1));
    const [entries, options] = mockBulkWrite.mock.calls[0] as [Record<string, unknown>[], unknown];
    expect(options).toEqual({ ordered: false });
    expect(entries[0]).toEqual({
      updateOne: {
        filter: { currency: 'BTC', timestamp: 0 },
        update: { $set: ops(1)[0].set },
        upsert: true,
      },
    });
  });

  it('does not call bulkWrite for an empty op list', async () => {
    expect(await bulkUpsertOptionsFlow([])).toBe(0);
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it('treats a zero-count result as success, not failure', async () => {
    mockBulkWrite.mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 });
    expect(await bulkUpsertOptionsFlow(ops(3))).toBe(0);
  });

  it('accepts a dvol-only op set, since one store serves both passes', async () => {
    const dvolOps: UpsertOp<Partial<OptionsFlowHourFields & DvolFields>>[] = [
      { filter: { currency: 'BTC', timestamp: 0 }, set: { dvolOpen: 58, dvolClose: 60 } },
    ];
    await bulkUpsertOptionsFlow(dvolOps);
    const entries = mockBulkWrite.mock.calls[0][0] as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
  });
});
