// @vitest-environment node
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { stream } = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/external/binance-archive', async (orig) => ({
  ...(await orig<typeof import('@/lib/external/binance-archive')>()),
  streamArchiveCsvLines: stream,
}));

import { parseAggTradeLine } from '@/lib/archive-flow/agg-trades';
import { FlowFolder } from '@/lib/archive-flow/fold';
import { ArchiveFlowBar } from '@/lib/models/archive-flow-bar';
import { ArchiveFlowFile } from '@/lib/models/archive-flow-file';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { buildJobs, parseArgs, periodsBetween, run, type Args } from './ingest-agg-flow';

const HEADER =
  'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker';
const BASE = 1_700_000_100_000 - (1_700_000_100_000 % 300_000);
const ROWS = [
  `1,10,2,1,3,${BASE + 1_000},false`,
  `2,10,1,4,4,${BASE + 20_000},true`,
  `3,20000,10,5,5,${BASE + 200_000},false`,
  `4,10,3,6,8,${BASE + 300_000 + 5_000},true`,
  `5,10,4,9,9,${BASE + 600_000 + 1},false`,
];

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([ArchiveFlowBar.init(), ArchiveFlowFile.init()]);
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(() => {
  stream.mockReset();
  stream.mockImplementation(okMonth);
});

afterEach(async () => {
  await ArchiveFlowBar.deleteMany({});
  await ArchiveFlowFile.deleteMany({});
});

async function okMonth(_spec: unknown, onLine: (l: string) => void | Promise<void>) {
  for (const line of [HEADER, ...ROWS]) await onLine(line);
  return { status: 'ok', lines: ROWS.length + 1, uncompressedBytes: 1234 };
}

function args(over: Partial<Args> = {}): Args {
  return {
    symbols: ['BTCUSDT'],
    from: '2024-01',
    to: '2024-01',
    concurrency: 1,
    refresh: false,
    dryRun: false,
    ...over,
  };
}

function quiet() {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: (l: object) => void lines.push(l as Record<string, unknown>) };
}

function expectedBuckets() {
  const folder = new FlowFolder();
  const out = [];
  for (const row of ROWS) {
    const trade = parseAggTradeLine(row);
    if (trade) out.push(...folder.add(trade));
  }
  return [...out, ...folder.flush()];
}

describe('parseArgs and jobs', () => {
  it('defaults to the signal symbols and 2023-01..2026-06', () => {
    const a = parseArgs([]);
    expect(a).toEqual({
      symbols: [...SIGNAL_SYMBOLS],
      from: '2023-01',
      to: '2026-06',
      concurrency: 1,
      refresh: false,
      dryRun: false,
    });
    expect(buildJobs(a)).toHaveLength(10 * 42);
  });

  it('enumerates months inclusively across years', () => {
    expect(periodsBetween('2023-11', '2024-02')).toEqual([
      '2023-11',
      '2023-12',
      '2024-01',
      '2024-02',
    ]);
  });

  it('parses flags', () => {
    expect(
      parseArgs([
        '--symbols',
        'btcusdt,ethusdt',
        '--from',
        '2024-01',
        '--to',
        '2024-03',
        '--concurrency',
        '2',
        '--refresh',
        '--dry-run',
      ])
    ).toEqual({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      from: '2024-01',
      to: '2024-03',
      concurrency: 2,
      refresh: true,
      dryRun: true,
    });
  });

  it('rejects bad input', () => {
    expect(() => parseArgs(['--from', '2024-13'])).toThrow(/YYYY-MM/);
    expect(() => parseArgs(['--from', '2024-05', '--to', '2024-01'])).toThrow(/after/);
    expect(() => parseArgs(['--concurrency', '0'])).toThrow(/positive/);
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown flag/);
  });

  it('refuses the lockbox before any download', async () => {
    expect(() => parseArgs(['--to', '2026-07'])).toThrow(/Lockbox/);
    expect(() => parseArgs(['--from', '2026-08', '--to', '2026-09'])).toThrow(/Lockbox/);
    // And again if a caller skips parseArgs.
    await expect(run(args({ from: '2026-05', to: '2026-07' }), quiet().log)).rejects.toThrow(
      /Lockbox/
    );
    expect(stream).not.toHaveBeenCalled();
  });
});

describe('run', () => {
  it('writes the folder output and the ledger row', async () => {
    const { lines, log } = quiet();
    expect(await run(args(), log)).toBe(0);

    const docs = await ArchiveFlowBar.find({ symbol: 'BTCUSDT' }).sort({ bucketStart: 1 }).lean();
    const expected = expectedBuckets();
    expect(expected).toHaveLength(3);
    expect(docs).toHaveLength(3);
    docs.forEach((doc, i) => {
      expect(doc).toMatchObject({
        ...expected[i],
        symbol: 'BTCUSDT',
        source: 'BTCUSDT-aggTrades-2024-01.zip',
      });
    });

    const ledger = await ArchiveFlowFile.findOne({ symbol: 'BTCUSDT', period: '2024-01' }).lean();
    expect(ledger).toMatchObject({
      status: 'complete',
      lines: 6,
      buckets: 3,
      outOfOrder: 0,
      bytesUncompressed: 1234,
      crcOk: true,
    });
    expect(ledger?.startedAt).toBeInstanceOf(Date);
    expect(ledger?.completedAt).toBeInstanceOf(Date);

    expect(lines[0]).toMatchObject({
      symbol: 'BTCUSDT',
      period: '2024-01',
      status: 'complete',
      lines: 6,
      buckets: 3,
      outOfOrder: 0,
    });
    expect(typeof lines[0].seconds).toBe('number');
    expect(lines[1]).toMatchObject({ summary: true, files: 1, complete: 1, failed: 0 });
  });

  it('skips a completed file on the second run and writes nothing', async () => {
    await run(args(), quiet().log);
    const before = await ArchiveFlowFile.findOne({}).lean();
    stream.mockClear();
    const bulk = vi.spyOn(ArchiveFlowBar, 'bulkWrite');

    const { lines, log } = quiet();
    expect(await run(args(), log)).toBe(0);
    expect(stream).not.toHaveBeenCalled();
    expect(bulk).not.toHaveBeenCalled();
    expect(lines[0]).toMatchObject({ status: 'skipped' });
    expect(await ArchiveFlowFile.findOne({}).lean()).toEqual(before);
    bulk.mockRestore();
  });

  it('--refresh rewrites idempotently', async () => {
    await run(args(), quiet().log);
    const first = await ArchiveFlowBar.find({}).sort({ bucketStart: 1 }).select('-_id -__v').lean();
    stream.mockClear();

    expect(await run(args({ refresh: true }), quiet().log)).toBe(0);
    expect(stream).toHaveBeenCalledTimes(1);
    const second = await ArchiveFlowBar.find({})
      .sort({ bucketStart: 1 })
      .select('-_id -__v')
      .lean();
    expect(second).toEqual(first);
    expect(await ArchiveFlowFile.countDocuments({})).toBe(1);
  });

  it('writes no bucket while the stream is open and none for a stream that fails', async () => {
    let written = -1;
    stream.mockImplementation(async (spec: { symbol: string }, onLine: (l: string) => void) => {
      if (spec.symbol === 'ETHUSDT') {
        onLine(HEADER);
        for (const row of ROWS) onLine(row);
        written = await ArchiveFlowBar.countDocuments({});
        throw new Error('connection reset');
      }
      return okMonth(spec, onLine);
    });

    const { lines, log } = quiet();
    const code = await run(args({ symbols: ['ETHUSDT', 'BTCUSDT'] }), log);

    expect(written).toBe(0);
    expect(code).toBe(1);
    expect(await ArchiveFlowFile.find({ symbol: 'ETHUSDT' })).toHaveLength(0);
    expect(await ArchiveFlowBar.countDocuments({ symbol: 'ETHUSDT' })).toBe(0);
    // The run went on to the next file.
    expect(await ArchiveFlowFile.countDocuments({ symbol: 'BTCUSDT', status: 'complete' })).toBe(1);
    expect(lines[0]).toMatchObject({
      symbol: 'ETHUSDT',
      status: 'error',
      error: 'connection reset',
    });
    expect(lines[2]).toMatchObject({ summary: true, failed: 1, complete: 1 });

    // The failed file is retried on the next run.
    stream.mockImplementation(okMonth);
    expect(await run(args({ symbols: ['ETHUSDT', 'BTCUSDT'] }), quiet().log)).toBe(0);
    expect(await ArchiveFlowFile.countDocuments({ symbol: 'ETHUSDT', status: 'complete' })).toBe(1);
  });

  it('records a 404 as missing and does not retry it', async () => {
    stream.mockResolvedValue({ status: 'missing' });
    const { lines, log } = quiet();
    expect(await run(args(), log)).toBe(0);
    expect(await ArchiveFlowBar.countDocuments({})).toBe(0);
    expect(
      await ArchiveFlowFile.findOne({ symbol: 'BTCUSDT', period: '2024-01' }).lean()
    ).toMatchObject({
      status: 'missing',
      buckets: 0,
    });
    expect(lines[0]).toMatchObject({ status: 'missing' });
    expect(lines[1]).toMatchObject({ missing: 1 });

    stream.mockClear();
    await run(args(), quiet().log);
    expect(stream).not.toHaveBeenCalled();
  });

  it('--dry-run lists pending and complete files and writes nothing', async () => {
    await run(args({ to: '2024-01' }), quiet().log);
    stream.mockClear();
    const { lines, log } = quiet();

    expect(await run(args({ to: '2024-02', dryRun: true }), log)).toBe(0);
    expect(lines).toEqual([
      { symbol: 'BTCUSDT', period: '2024-01', status: 'complete' },
      { symbol: 'BTCUSDT', period: '2024-02', status: 'pending' },
    ]);
    expect(stream).not.toHaveBeenCalled();
    expect(await ArchiveFlowFile.countDocuments({})).toBe(1);
  });

  it('runs files with the requested concurrency and records outOfOrder', async () => {
    stream.mockImplementation(async (_s: unknown, onLine: (l: string) => void) => {
      onLine(`1,10,2,1,1,${BASE + 400_000},false`);
      onLine(`2,10,2,2,2,${BASE},false`);
      return { status: 'ok', lines: 2, uncompressedBytes: 1 };
    });
    const { lines, log } = quiet();
    expect(await run(args({ symbols: ['BTCUSDT', 'ETHUSDT'], concurrency: 2 }), log)).toBe(0);
    expect(await ArchiveFlowFile.countDocuments({ outOfOrder: 1 })).toBe(2);
    expect(lines[lines.length - 1]).toMatchObject({ summary: true, outOfOrderFiles: 2 });
  });
});
