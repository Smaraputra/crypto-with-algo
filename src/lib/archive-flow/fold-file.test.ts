// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { stream } = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@/lib/external/binance-archive', async (orig) => ({
  ...(await orig<typeof import('@/lib/external/binance-archive')>()),
  streamArchiveCsvLines: stream,
}));

import { foldArchiveFile } from './fold-file';

const spec = { dataset: 'aggTrades', symbol: 'BTCUSDT', date: '2026-10-08', cadence: 'daily' } as const;
const HEADER = 'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker';
const BASE = 1_700_000_100_000 - (1_700_000_100_000 % 300_000);

beforeEach(() => {
  stream.mockReset();
});

describe('foldArchiveFile', () => {
  it('skips the header, folds rows, and flushes the last bucket', async () => {
    stream.mockImplementation(async (_s, onLine) => {
      for (const l of [HEADER, `1,10,2,1,3,${BASE},false`, `2,10,1,4,4,${BASE + 300_000},true`]) await onLine(l);
      return { status: 'ok', lines: 3, uncompressedBytes: 1 };
    });
    const r = await foldArchiveFile(spec);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.rows).toBe(2);
    expect(r.outOfOrder).toBe(0);
    expect(r.uncompressedBytes).toBe(1);
    expect(r.buckets.map((b) => [b.bucketStart, b.buyQuote, b.sellQuote, b.trades])).toEqual([
      [BASE, 20, 0, 3],
      [BASE + 300_000, 0, 10, 1],
    ]);
  });

  it('discards the partial fold on a restart', async () => {
    stream.mockImplementation(async (_s, onLine, opts) => {
      await onLine(`1,10,2,1,1,${BASE},false`);
      opts.onRestart();
      await onLine(`1,10,2,1,1,${BASE},false`);
      return { status: 'ok', lines: 1, uncompressedBytes: 1 };
    });
    const r = await foldArchiveFile(spec);
    expect(r.status === 'ok' && r.buckets[0].buyQuote).toBe(20);
  });

  it('passes through a missing file', async () => {
    stream.mockResolvedValue({ status: 'missing' });
    expect(await foldArchiveFile(spec)).toEqual({ status: 'missing' });
  });
});
