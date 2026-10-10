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
import {
  assertBucketsInRange,
  buildJobs,
  missingDaysOf,
  parseArgs,
  parseRepairList,
  periodsBetween,
  rangeOf,
  run,
  type Args,
} from './ingest-agg-flow';

const HEADER =
  'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker';
const BASE = Date.UTC(2024, 0, 10);
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
    dailyRepair: [],
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
      dailyRepair: [],
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
        '--daily-repair',
        'btcusdt:2024-01-05,ETHUSDT:2024-02-01',
      ])
    ).toEqual({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      from: '2024-01',
      to: '2024-03',
      concurrency: 2,
      refresh: true,
      dryRun: true,
      dailyRepair: [
        { symbol: 'BTCUSDT', date: '2024-01-05' },
        { symbol: 'ETHUSDT', date: '2024-02-01' },
      ],
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
      expectedBuckets: 31 * 288,
      crcOk: true,
    });
    expect(ledger?.missingDays).toHaveLength(31);
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
    expect(lines[1]).toMatchObject({
      coverage: true,
      symbol: 'BTCUSDT',
      period: '2024-01',
      expectedBuckets: 31 * 288,
    });
    expect((lines[1].missingDays as string[]).length).toBe(31);
    expect(lines[2]).toMatchObject({
      summary: true,
      files: 1,
      complete: 1,
      failed: 0,
      filesWithMissing: 1,
    });
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
    // Coverage is reported for skipped files too, from the ledger.
    expect(lines[1]).toMatchObject({ coverage: true, period: '2024-01' });
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
    expect(lines[lines.length - 1]).toMatchObject({ summary: true, failed: 1, complete: 1 });

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

describe('month guard', () => {
  const MONTH = rangeOf('2024-01');

  it('assertBucketsInRange passes inside [start, end) and names first and last on failure', () => {
    expect(() =>
      assertBucketsInRange(
        'x',
        [{ bucketStart: MONTH.start }, { bucketStart: MONTH.end - 300_000 }],
        MONTH.start,
        MONTH.end
      )
    ).not.toThrow();
    expect(() =>
      assertBucketsInRange(
        'x',
        [{ bucketStart: MONTH.start }, { bucketStart: MONTH.end }],
        MONTH.start,
        MONTH.end
      )
    ).toThrow(
      /1 of 2 buckets[\s\S]*first bucketStart 2024-01-01T00:00:00.000Z, last bucketStart 2024-02-01T00:00:00.000Z/
    );
  });

  it('a boundary trade from the next month fails the file with no writes and no ledger row', async () => {
    stream.mockImplementation(async (_s: unknown, onLine: (l: string) => void) => {
      for (const row of ROWS) onLine(row);
      onLine(`9,10,1,10,10,${Date.UTC(2024, 1, 1, 0, 0, 1)},false`);
      return { status: 'ok', lines: 6, uncompressedBytes: 1 };
    });
    const { lines, log } = quiet();
    expect(await run(args(), log)).toBe(1);
    expect(lines[0]).toMatchObject({ status: 'error' });
    expect(String(lines[0].error)).toMatch(
      /first bucketStart 2024-01-10T00:00:00.000Z, last bucketStart 2024-02-01T00:00:00.000Z/
    );
    expect(await ArchiveFlowBar.countDocuments({})).toBe(0);
    expect(await ArchiveFlowFile.countDocuments({})).toBe(0);
  });

  it('a microsecond timestamp is rejected by the parser, so the file fails and writes nothing', async () => {
    stream.mockImplementation(async (_s: unknown, onLine: (l: string) => void) => {
      for (const row of ROWS) onLine(row);
      onLine(`9,10,1,10,10,${BASE * 1000},false`);
      return { status: 'ok', lines: 6, uncompressedBytes: 1 };
    });
    expect(await run(args(), quiet().log)).toBe(1);
    expect(await ArchiveFlowBar.countDocuments({})).toBe(0);
    expect(await ArchiveFlowFile.countDocuments({})).toBe(0);
  });
});

describe('coverage', () => {
  it('missingDaysOf counts a day with 287 buckets as missing and 288 as complete', () => {
    const { start, end } = rangeOf('2024-02');
    const starts: number[] = [];
    for (let day = 0; day < 29; day++) {
      const n = day === 3 ? 287 : day === 5 ? 0 : 288;
      for (let i = 0; i < n; i++) starts.push(start + day * 86_400_000 + i * 300_000);
    }
    expect(missingDaysOf(starts, start, end)).toEqual(['2024-02-04', '2024-02-06']);
  });
});

describe('--daily-repair', () => {
  const DAY = Date.UTC(2024, 0, 5);
  const dayRows = [`1,10,2,1,1,${DAY + 1_000},false`, `2,10,1,2,2,${DAY + 301_000},true`];

  it('parses and refuses lockbox dates, bad shapes and impossible dates', () => {
    expect(parseRepairList('btcusdt:2024-01-05')).toEqual([
      { symbol: 'BTCUSDT', date: '2024-01-05' },
    ]);
    expect(() => parseRepairList('BTCUSDT:2026-07-01')).toThrow(/Lockbox/);
    expect(() => parseRepairList('BTCUSDT:2026-06-30')).not.toThrow();
    expect(() => parseRepairList('BTCUSDT')).toThrow(/SYMBOL:YYYY-MM-DD/);
    expect(() => parseRepairList('BTCUSDT:2024-02-30')).toThrow(/impossible/);
    expect(() => parseArgs(['--daily-repair', 'BTCUSDT:2026-08-01'])).toThrow(/Lockbox/);
  });

  it('ingests the daily file, fills the month, and refreshes ledger coverage', async () => {
    await run(args(), quiet().log);
    const before = await ArchiveFlowFile.findOne({}).lean();
    expect(before?.missingDays).toContain('2024-01-05');

    stream.mockClear();
    stream.mockImplementation(async (_s: unknown, onLine: (l: string) => void) => {
      for (const row of dayRows) onLine(row);
      return { status: 'ok', lines: 2, uncompressedBytes: 1 };
    });
    const { lines, log } = quiet();
    expect(await run(args({ dailyRepair: [{ symbol: 'BTCUSDT', date: '2024-01-05' }] }), log)).toBe(
      0
    );
    expect(stream.mock.calls[0][0]).toMatchObject({
      dataset: 'aggTrades',
      symbol: 'BTCUSDT',
      date: '2024-01-05',
      cadence: 'daily',
    });
    expect(lines[0]).toMatchObject({ repair: true, status: 'repaired', buckets: 2 });
    expect(
      await ArchiveFlowBar.countDocuments({ bucketStart: { $gte: DAY, $lt: DAY + 86_400_000 } })
    ).toBe(2);
    const after = await ArchiveFlowFile.findOne({}).lean();
    // Still short of 288 buckets, so the day stays listed, and the month's other buckets stay.
    expect(after?.missingDays).toContain('2024-01-05');
    expect(await ArchiveFlowBar.countDocuments({})).toBe(5);
  });

  it('a daily file with a bucket outside its day fails with no writes', async () => {
    stream.mockImplementation(async (_s: unknown, onLine: (l: string) => void) => {
      for (const row of dayRows) onLine(row);
      onLine(`3,10,1,3,3,${DAY + 86_400_000 + 5},false`);
      return { status: 'ok', lines: 3, uncompressedBytes: 1 };
    });
    const { lines, log } = quiet();
    expect(await run(args({ dailyRepair: [{ symbol: 'BTCUSDT', date: '2024-01-05' }] }), log)).toBe(
      1
    );
    expect(lines[0]).toMatchObject({ repair: true, status: 'error' });
    expect(await ArchiveFlowBar.countDocuments({})).toBe(0);
  });

  it('refuses a lockbox date in run() before any download', async () => {
    await expect(
      run(args({ dailyRepair: [{ symbol: 'BTCUSDT', date: '2026-07-01' }] }), quiet().log)
    ).rejects.toThrow(/Lockbox/);
    expect(stream).not.toHaveBeenCalled();
  });
});

describe('--allow-lockbox (forward test, opt-in)', () => {
  const JUL = Date.UTC(2026, 6, 10);
  const julRows = [`1,10,2,1,1,${JUL + 1_000},false`, `2,10,1,2,2,${JUL + 301_000},true`];
  const OCT = Date.UTC(2026, 9, 5);
  const octRows = [`1,10,2,1,1,${OCT + 1_000},false`, `2,10,1,2,2,${OCT + 301_000},true`];

  it('is off by default and parseArgs output has no new keys', () => {
    const a = parseArgs([]);
    expect(a).not.toHaveProperty('allowLockbox');
    expect(a).not.toHaveProperty('maxDate');
    expect(() => parseArgs(['--to', '2026-07'])).toThrow(/Lockbox/);
    expect(() => parseArgs(['--max-date', '2026-10-09', '--to', '2026-07'])).toThrow(/Lockbox/);
  });

  it('requires --max-date and a valid date', () => {
    expect(() => parseArgs(['--allow-lockbox', '--to', '2026-09'])).toThrow(/--max-date/);
    expect(() => parseArgs(['--allow-lockbox', '--max-date', '2026-10-32', '--to', '2026-09'])).toThrow(/--max-date/);
  });

  it('lifts the lockbox for periods and repair dates up to --max-date', () => {
    const a = parseArgs([
      '--allow-lockbox', '--max-date', '2026-10-09', '--from', '2026-07', '--to', '2026-09',
      '--daily-repair', 'BTCUSDT:2026-10-09',
    ]);
    expect(a.allowLockbox).toBe(true);
    expect(a.maxDate).toBe('2026-10-09');
    expect(a.dailyRepair).toEqual([{ symbol: 'BTCUSDT', date: '2026-10-09' }]);
    expect(buildJobs(a)).toHaveLength(10 * 3);
  });

  it('refuses periods and dates after --max-date', () => {
    expect(() => parseArgs(['--allow-lockbox', '--max-date', '2026-09-30', '--from', '2026-07', '--to', '2026-10'])).toThrow(
      /Max date/
    );
    expect(() =>
      parseArgs(['--allow-lockbox', '--max-date', '2026-10-09', '--daily-repair', 'BTCUSDT:2026-10-10'])
    ).toThrow(/Max date/);
    expect(() => parseRepairList('BTCUSDT:2026-10-10', { allowLockbox: true, maxDate: '2026-10-09' })).toThrow(/Max date/);
  });

  it('ingests a lockbox month, logs that the lockbox is allowed, and still refuses without the flag', async () => {
    stream.mockImplementation(async (_s: unknown, onLine: (l: string) => void) => {
      for (const row of [HEADER, ...julRows]) onLine(row);
      return { status: 'ok', lines: 3, uncompressedBytes: 1 };
    });
    const out = quiet();
    const code = await run(
      args({ from: '2026-07', to: '2026-07', allowLockbox: true, maxDate: '2026-10-09' }),
      out.log
    );
    expect(code).toBe(0);
    expect(out.lines[0]).toMatchObject({ lockbox: 'allowed', maxDate: '2026-10-09' });
    expect(out.lines.some((l) => l.status === 'complete' || l.status === 'missing')).toBe(true);
    expect(await ArchiveFlowBar.countDocuments({})).toBeGreaterThan(0);
    await expect(run(args({ from: '2026-07', to: '2026-07' }), quiet().log)).rejects.toThrow(/Lockbox/);
  });

  it('repairs a lockbox day, and refuses one after --max-date at run time', async () => {
    stream.mockImplementation(async (_s: unknown, onLine: (l: string) => void) => {
      for (const row of octRows) onLine(row);
      return { status: 'ok', lines: 2, uncompressedBytes: 1 };
    });
    const out = quiet();
    const code = await run(
      args({ allowLockbox: true, maxDate: '2026-10-09', dailyRepair: [{ symbol: 'BTCUSDT', date: '2026-10-05' }] }),
      out.log
    );
    expect(code).toBe(0);
    expect(out.lines.find((l) => l.repair)).toMatchObject({ status: 'repaired', date: '2026-10-05' });
    await expect(
      run(
        args({ allowLockbox: true, maxDate: '2026-10-09', dailyRepair: [{ symbol: 'BTCUSDT', date: '2026-10-10' }] }),
        quiet().log
      )
    ).rejects.toThrow(/Max date/);
  });
});
