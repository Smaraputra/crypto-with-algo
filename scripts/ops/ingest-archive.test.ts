// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockConnectDB,
  mockFetchArchiveFile,
  mockMetricBulkWrite,
  mockPerpBulkWrite,
  mockMetricFind,
  mockBulkUpsertSnapshots,
} = vi.hoisted(() => ({
  mockConnectDB: vi.fn(),
  mockFetchArchiveFile: vi.fn(),
  mockMetricBulkWrite: vi.fn(),
  mockPerpBulkWrite: vi.fn(),
  mockMetricFind: vi.fn(),
  mockBulkUpsertSnapshots: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({ connectDB: () => mockConnectDB() }));

vi.mock('@/lib/models/futures-metric', () => ({
  FuturesMetric: {
    bulkWrite: (...args: unknown[]) => mockMetricBulkWrite(...args),
    find: (...args: unknown[]) => mockMetricFind(...args),
  },
}));

vi.mock('@/lib/models/perp-candle', () => ({
  PerpCandle: { bulkWrite: (...args: unknown[]) => mockPerpBulkWrite(...args) },
  PERP_SERIES: ['klines', 'premiumIndex', 'markPrice'],
}));

vi.mock('@/lib/historical-snapshots', async () => {
  const actual = await vi.importActual<typeof import('@/lib/historical-snapshots')>(
    '@/lib/historical-snapshots'
  );
  return {
    alignTimestamp: actual.alignTimestamp,
    bulkUpsertSnapshots: (...args: unknown[]) => mockBulkUpsertSnapshots(...args),
  };
});

vi.mock('@/lib/external/binance-archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/external/binance-archive')>(
    '@/lib/external/binance-archive'
  );
  return { ...actual, fetchArchiveFile: (...args: unknown[]) => mockFetchArchiveFile(...args) };
});

import { DATASET_KINDS, buildJobs, jobFileKeys, main, parseArgs } from './ingest-archive';

const NOW = new Date('2026-09-20T09:00:00Z');

describe('parseArgs', () => {
  it('defaults to a metrics pass plus the snapshot backfill', () => {
    const args = parseArgs([], NOW);
    expect(args.datasets).toEqual(['metrics', 'snapshots']);
    expect(args.symbols).toHaveLength(10);
    expect(args.symbols[0]).toBe('BTCUSDT');
    expect(args.intervals).toEqual(['5m', '15m', '1h', '4h', '1d']);
    expect(args.snapshotIntervals).toEqual(['1h', '4h', '1d']);
    expect(args.cacheDir).toBe('data/archive-cache');
    expect(args.concurrency).toBe(8);
    expect(args.refresh).toBe(false);
    expect(args.dryRun).toBe(false);
  });

  it('defaults --from to the archive floor and --to to yesterday', () => {
    const args = parseArgs([], NOW);
    expect(new Date(args.fromMs).toISOString().slice(0, 10)).toBe('2021-01-01');
    // Today's daily file does not exist yet, so asking for it is a sure 404.
    expect(new Date(args.toMs).toISOString().slice(0, 10)).toBe('2026-09-19');
  });

  it('parses every flag', () => {
    const args = parseArgs(
      [
        '--datasets', 'klines,bookDepth',
        '--symbols', 'BTCUSDT,ETHUSDT',
        '--intervals', '1h,4h',
        '--snapshot-intervals', '4h',
        '--from', '2024-01-01',
        '--to', '2024-03-31',
        '--cache-dir', '/tmp/zips',
        '--concurrency', '3',
        '--refresh',
        '--dry-run',
      ],
      NOW
    );
    expect(args.datasets).toEqual(['klines', 'bookDepth']);
    expect(args.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(args.intervals).toEqual(['1h', '4h']);
    expect(args.snapshotIntervals).toEqual(['4h']);
    expect(args.fromMs).toBe(Date.UTC(2024, 0, 1));
    expect(args.toMs).toBe(Date.UTC(2024, 2, 31));
    expect(args.cacheDir).toBe('/tmp/zips');
    expect(args.concurrency).toBe(3);
    expect(args.refresh).toBe(true);
    expect(args.dryRun).toBe(true);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--bogus'], NOW)).toThrow(/Unknown flag "--bogus"/);
  });

  it('rejects a flag with no value', () => {
    expect(() => parseArgs(['--symbols'], NOW)).toThrow(/--symbols requires a value/);
    expect(() => parseArgs(['--symbols', '--dry-run'], NOW)).toThrow(/--symbols requires a value/);
  });

  it('rejects an unknown dataset, naming the valid ones', () => {
    expect(() => parseArgs(['--datasets', 'bookTicker'], NOW)).toThrow(/unknown dataset "bookTicker"/);
    // bookTicker serves no files for UM futures, so it must not be accepted.
    expect(DATASET_KINDS).not.toContain('bookTicker');
    expect(DATASET_KINDS).not.toContain('aggTrades');
  });

  it('rejects an unknown interval', () => {
    expect(() => parseArgs(['--intervals', '3m'], NOW)).toThrow(/unknown interval "3m"/);
    expect(() => parseArgs(['--snapshot-intervals', '7h'], NOW)).toThrow(/unknown interval "7h"/);
  });

  it('rejects a malformed or impossible date', () => {
    expect(() => parseArgs(['--from', '2024-1-1'], NOW)).toThrow(/expected YYYY-MM-DD/);
    expect(() => parseArgs(['--to', 'yesterday'], NOW)).toThrow(/expected YYYY-MM-DD/);
  });

  it('rejects a range that runs backwards', () => {
    expect(() => parseArgs(['--from', '2024-06-01', '--to', '2024-01-01'], NOW)).toThrow(/is before --from/);
  });

  it('rejects a non-positive concurrency', () => {
    expect(() => parseArgs(['--concurrency', '0'], NOW)).toThrow(/positive integer/);
    expect(() => parseArgs(['--concurrency', 'many'], NOW)).toThrow(/positive integer/);
  });
});

describe('buildJobs', () => {
  const base = parseArgs(['--symbols', 'BTCUSDT,ETHUSDT'], NOW);

  it('emits one job per symbol for a dataset with no interval', () => {
    const jobs = buildJobs({ ...base, datasets: ['metrics'] });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.interval === undefined)).toBe(true);
    expect(jobs.map((j) => j.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('emits one job per symbol and interval for the kline-shaped datasets', () => {
    const jobs = buildJobs({ ...base, datasets: ['klines'], intervals: ['1h', '4h'] });
    expect(jobs).toHaveLength(4);
    expect(jobs.map((j) => `${j.symbol}:${j.interval}`)).toEqual([
      'BTCUSDT:1h', 'BTCUSDT:4h', 'ETHUSDT:1h', 'ETHUSDT:4h',
    ]);
  });

  it('uses the snapshot intervals for the snapshots job, not the kline ones', () => {
    const jobs = buildJobs({
      ...base,
      datasets: ['snapshots'],
      intervals: ['5m'],
      snapshotIntervals: ['1h', '1d'],
    });
    expect(jobs.map((j) => j.interval)).toEqual(['1h', '1d', '1h', '1d']);
  });

  it('always orders the snapshots job last, since it reads what metrics wrote', () => {
    const jobs = buildJobs({
      ...base,
      datasets: ['snapshots', 'metrics'],
      symbols: ['BTCUSDT'],
      snapshotIntervals: ['1h'],
    });
    expect(jobs.map((j) => j.kind)).toEqual(['metrics', 'snapshots']);
  });

  it('carries the range onto every job', () => {
    const jobs = buildJobs({ ...base, datasets: ['metrics'] });
    expect(jobs[0].fromMs).toBe(base.fromMs);
    expect(jobs[0].toMs).toBe(base.toMs);
  });
});

describe('jobFileKeys', () => {
  const from = Date.UTC(2024, 0, 30);
  const to = Date.UTC(2024, 1, 2);

  it('enumerates days for a daily dataset', () => {
    expect(jobFileKeys({ kind: 'metrics', symbol: 'BTCUSDT', fromMs: from, toMs: to })).toEqual([
      '2024-01-30', '2024-01-31', '2024-02-01', '2024-02-02',
    ]);
    expect(jobFileKeys({ kind: 'bookDepth', symbol: 'BTCUSDT', fromMs: from, toMs: to })).toHaveLength(4);
  });

  it('enumerates months for a monthly dataset', () => {
    expect(
      jobFileKeys({ kind: 'klines', symbol: 'BTCUSDT', interval: '1h', fromMs: from, toMs: to })
    ).toEqual(['2024-01', '2024-02']);
    expect(jobFileKeys({ kind: 'fundingRate', symbol: 'BTCUSDT', fromMs: from, toMs: to })).toEqual([
      '2024-01', '2024-02',
    ]);
  });

  it('needs no files for the snapshots job', () => {
    expect(jobFileKeys({ kind: 'snapshots', symbol: 'BTCUSDT', interval: '1h', fromMs: from, toMs: to })).toEqual([]);
  });
});

describe('main', () => {
  const logged: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logged.length = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(line);
    });
    mockMetricBulkWrite.mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 });
    mockPerpBulkWrite.mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 });
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.argv = ['node', 'ingest-archive'];
  });

  function run(flags: string[]): Promise<number> {
    process.argv = ['node', 'ingest-archive', ...flags];
    return main();
  }

  it('prints the job list and touches nothing on a dry run', async () => {
    const code = await run([
      '--dry-run', '--datasets', 'metrics', '--symbols', 'BTCUSDT',
      '--from', '2024-01-01', '--to', '2024-01-03',
    ]);
    expect(code).toBe(0);
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockFetchArchiveFile).not.toHaveBeenCalled();
    expect(JSON.parse(logged[0])).toMatchObject({ kind: 'metrics', symbol: 'BTCUSDT', files: 3 });
  });

  it('ingests a metrics day into FuturesMetric', async () => {
    mockFetchArchiveFile.mockResolvedValue(
      'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio\n' +
        '2024-01-01 00:00:00,BTCUSDT,100,1000000,1.2,1.5,2,0.9\n' +
        '2024-01-01 00:05:00,BTCUSDT,101,1010000,1.3,1.6,2.1,1.1\n'
    );
    mockMetricBulkWrite.mockResolvedValue({ upsertedCount: 2, modifiedCount: 0 });

    const code = await run([
      '--datasets', 'metrics', '--symbols', 'BTCUSDT', '--from', '2024-01-01', '--to', '2024-01-01',
    ]);

    expect(code).toBe(0);
    expect(mockConnectDB).toHaveBeenCalled();
    const summary = JSON.parse(logged[0]);
    expect(summary).toMatchObject({ kind: 'metrics', symbol: 'BTCUSDT', files: 1, missing: 0, rows: 2, written: 2 });

    const ops = mockMetricBulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.filter).toEqual({ symbol: 'BTCUSDT', timestamp: Date.UTC(2024, 0, 1) });
    expect(ops[0].updateOne.update.$set.openInterest).toBe(100);
    expect(ops[0].updateOne.upsert).toBe(true);
  });

  it('counts a missing archive day without failing the run', async () => {
    mockFetchArchiveFile.mockResolvedValue(null);
    const code = await run([
      '--datasets', 'metrics', '--symbols', 'BTCUSDT', '--from', '2024-01-01', '--to', '2024-01-02',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(logged[0])).toMatchObject({ files: 2, missing: 2, rows: 0, written: 0 });
    expect(mockMetricBulkWrite).not.toHaveBeenCalled();
  });

  it('writes perp klines with the right series', async () => {
    mockFetchArchiveFile.mockResolvedValue(
      '1704067200000,42314.00,42437.20,42289.60,42437.10,1724.21,1704067499999,73068834.13,15368,1274.87,54029686.66,0\n'
    );
    const code = await run([
      '--datasets', 'klines', '--symbols', 'BTCUSDT', '--intervals', '5m',
      '--from', '2024-01-01', '--to', '2024-01-01',
    ]);
    expect(code).toBe(0);
    const ops = mockPerpBulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.filter).toEqual({
      symbol: 'BTCUSDT', interval: '5m', series: 'klines', timestamp: 1704067200000,
    });
    expect(ops[0].updateOne.update.$set.close).toBe(42437.1);
  });

  it('writes premium index bars under their own series', async () => {
    mockFetchArchiveFile.mockResolvedValue(
      '1704067200000,-0.00048,-0.00038,-0.0009,-0.00055,0,1704067499999,0,60,0,0,0\n'
    );
    await run([
      '--datasets', 'premiumIndex', '--symbols', 'BTCUSDT', '--intervals', '5m',
      '--from', '2024-01-01', '--to', '2024-01-01',
    ]);
    const ops = mockPerpBulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.filter.series).toBe('premiumIndex');
  });

  it('folds bookDepth onto the 5m grid', async () => {
    mockFetchArchiveFile.mockResolvedValue(
      'timestamp,percentage,depth,notional\n' +
        '2024-01-01 00:00:10,-1,1,100\n' +
        '2024-01-01 00:00:10,1,3,300\n' +
        '2024-01-01 00:06:00,-1,3,300\n' +
        '2024-01-01 00:06:00,1,1,100\n'
    );
    await run([
      '--datasets', 'bookDepth', '--symbols', 'BTCUSDT', '--from', '2024-01-01', '--to', '2024-01-01',
    ]);
    const ops = mockMetricBulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(2);
    expect(ops[0].updateOne.filter.timestamp).toBe(Date.UTC(2024, 0, 1, 0, 0));
    expect(ops[0].updateOne.update.$set.depthImbalance1).toBeCloseTo(-0.5, 10);
    expect(ops[1].updateOne.filter.timestamp).toBe(Date.UTC(2024, 0, 1, 0, 5));
    expect(ops[1].updateOne.update.$set.depthImbalance1).toBeCloseTo(0.5, 10);
  });

  it('patches snapshots from stored metrics rows', async () => {
    const base = Date.UTC(2024, 0, 1);
    mockMetricFind.mockReturnValue({
      sort: () => ({
        lean: async () => [
          { timestamp: base, openInterest: 100, openInterestValue: 1_000_000, topTraderPositionRatio: 3 },
          {
            timestamp: base + 60 * 60 * 1000,
            openInterest: 110,
            openInterestValue: 1_100_000,
            topTraderPositionRatio: 1,
          },
        ],
      }),
    });

    const code = await run([
      '--datasets', 'snapshots', '--symbols', 'BTCUSDT', '--snapshot-intervals', '1h',
      '--from', '2024-01-01', '--to', '2024-01-01',
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(logged[0])).toMatchObject({ kind: 'snapshots', metrics: 2, patched: 2 });

    const patches = mockBulkUpsertSnapshots.mock.calls[0][0];
    expect(patches[0]).toMatchObject({ symbol: 'BTCUSDT', interval: '1h', timestamp: base });
    // The top trader POSITION ratio, which is what the live path stores here.
    expect(patches[0].data.longShortRatio.ratio).toBe(3);
    expect(patches[0].data.longShortRatio.longAccount).toBeCloseTo(0.75, 10);
    expect(patches[0].data.openInterest).toEqual({ value: 100, sumValue: 1_000_000 });
    // Only these two fields are written, so live news and Fear and Greed survive.
    expect(Object.keys(patches[0].data).sort()).toEqual(['longShortRatio', 'openInterest']);
  });

  it('reports no work when there are no stored metrics to patch from', async () => {
    mockMetricFind.mockReturnValue({ sort: () => ({ lean: async () => [] }) });
    const code = await run([
      '--datasets', 'snapshots', '--symbols', 'BTCUSDT', '--snapshot-intervals', '1h',
      '--from', '2024-01-01', '--to', '2024-01-01',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(logged[0])).toMatchObject({ metrics: 0, bars: 0, patched: 0 });
    expect(mockBulkUpsertSnapshots).not.toHaveBeenCalled();
  });

  it('ingests each file as it arrives rather than collecting them all first', async () => {
    // The bookDepth OOM: an earlier version awaited every download into an
    // array before ingesting, so a job held all its files at once. Here the
    // first write must land before the last fetch resolves, which is only true
    // if download and ingest are interleaved per file.
    let fetches = 0;
    let firstWriteAfterFetches = -1;
    const totalDays = 6;

    mockFetchArchiveFile.mockImplementation(async () => {
      fetches++;
      return 'create_time,symbol,sum_open_interest\n2024-01-01 00:00:00,BTCUSDT,100\n';
    });
    mockMetricBulkWrite.mockImplementation(async () => {
      if (firstWriteAfterFetches === -1) firstWriteAfterFetches = fetches;
      return { upsertedCount: 1, modifiedCount: 0 };
    });

    await run([
      '--datasets', 'metrics', '--symbols', 'BTCUSDT',
      '--from', '2024-01-01', '--to', '2024-01-06', '--concurrency', '2',
    ]);

    expect(fetches).toBe(totalDays);
    expect(firstWriteAfterFetches).toBeGreaterThan(0);
    expect(firstWriteAfterFetches).toBeLessThan(totalDays);
  });

  it('holds at most `concurrency` files in flight at once', async () => {
    let inFlight = 0;
    let peak = 0;
    mockFetchArchiveFile.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return 'create_time,symbol,sum_open_interest\n2024-01-01 00:00:00,BTCUSDT,100\n';
    });

    await run([
      '--datasets', 'metrics', '--symbols', 'BTCUSDT',
      '--from', '2024-01-01', '--to', '2024-01-10', '--concurrency', '3',
    ]);

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('logs a failing job, keeps going, and exits non-zero', async () => {
    mockFetchArchiveFile
      .mockRejectedValueOnce(new Error('archive unreachable'))
      .mockResolvedValue('1704067200000,1,2,0.5,1.5,10,1704067499999,15,7,5,5,0\n');

    const code = await run([
      '--datasets', 'klines', '--symbols', 'BTCUSDT,ETHUSDT', '--intervals', '5m',
      '--from', '2024-01-01', '--to', '2024-01-01',
    ]);

    expect(code).toBe(1);
    expect(JSON.parse(logged[0])).toMatchObject({ kind: 'klines', symbol: 'BTCUSDT', error: 'archive unreachable' });
    expect(JSON.parse(logged[1])).toMatchObject({ kind: 'klines', symbol: 'ETHUSDT', rows: 1 });
  });
});
