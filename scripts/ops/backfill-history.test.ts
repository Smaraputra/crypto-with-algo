import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockConnectDB,
  mockBackfillCandles,
  mockGetCandleRange,
  mockFetchFundingHistory,
  mockLoadFearGreedLookup,
  mockBackfillSnapshotRange,
  mockUpdateMany,
} = vi.hoisted(() => ({
  mockConnectDB: vi.fn(),
  mockBackfillCandles: vi.fn(),
  mockGetCandleRange: vi.fn(),
  mockFetchFundingHistory: vi.fn(),
  mockLoadFearGreedLookup: vi.fn(),
  mockBackfillSnapshotRange: vi.fn(),
  mockUpdateMany: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: (...args: unknown[]) => mockConnectDB(...args),
}));
vi.mock('@/lib/candle-ingestion', () => ({
  backfillCandles: (...args: unknown[]) => mockBackfillCandles(...args),
  getCandleRange: (...args: unknown[]) => mockGetCandleRange(...args),
}));
vi.mock('@/lib/snapshot-backfill', () => ({
  fetchFundingHistory: (...args: unknown[]) => mockFetchFundingHistory(...args),
  loadFearGreedLookup: (...args: unknown[]) => mockLoadFearGreedLookup(...args),
  backfillSnapshotRange: (...args: unknown[]) => mockBackfillSnapshotRange(...args),
  MAX_FEAR_GREED_CARRY_DAYS: 3,
}));
vi.mock('@/lib/models/candle', () => ({
  Candle: { updateMany: (...args: unknown[]) => mockUpdateMany(...args) },
  VALID_INTERVALS: ['1m', '5m', '15m', '1h', '4h', '1d'],
}));

import { parseArgs, buildJobs, main, type Job } from './backfill-history';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

describe('parseArgs', () => {
  it('defaults symbols, candles, snapshots, and every flag', () => {
    const args = parseArgs([]);

    expect(args.symbols).toEqual([...SIGNAL_SYMBOLS]);
    expect(args.candles).toEqual([
      { interval: '5m', months: 12 },
      { interval: '15m', months: 12 },
      { interval: '1h', months: 60 },
      { interval: '4h', months: 96 },
      { interval: '1d', months: 96 },
    ]);
    expect(args.snapshots).toEqual([
      { interval: '1h', months: 60 },
      { interval: '4h', months: 96 },
      { interval: '1d', months: 96 },
    ]);
    expect(args.skipCandles).toBe(false);
    expect(args.skipSnapshots).toBe(false);
    expect(args.unsetFiveMinuteTtl).toBe(false);
    expect(args.dryRun).toBe(false);
  });

  it('overrides symbols from a comma list', () => {
    const args = parseArgs(['--symbols', 'BTCUSDT,ETHUSDT']);

    expect(args.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('overrides the candle and snapshot specs', () => {
    const args = parseArgs(['--candles', '1h:6,1d:12', '--snapshots', '4h:6']);

    expect(args.candles).toEqual([
      { interval: '1h', months: 6 },
      { interval: '1d', months: 12 },
    ]);
    expect(args.snapshots).toEqual([{ interval: '4h', months: 6 }]);
  });

  it('sets each boolean flag', () => {
    const args = parseArgs([
      '--skip-candles',
      '--skip-snapshots',
      '--unset-5m-ttl',
      '--dry-run',
    ]);

    expect(args.skipCandles).toBe(true);
    expect(args.skipSnapshots).toBe(true);
    expect(args.unsetFiveMinuteTtl).toBe(true);
    expect(args.dryRun).toBe(true);
  });

  it('rejects an unknown interval in a spec', () => {
    expect(() => parseArgs(['--candles', '2h:12'])).toThrow(/unknown interval/i);
  });

  it('rejects a non-integer month count', () => {
    expect(() => parseArgs(['--candles', '1h:abc'])).toThrow(/integer/i);
  });

  it('rejects months below 1', () => {
    expect(() => parseArgs(['--candles', '1h:0'])).toThrow(/at least 1/i);
  });

  it('rejects an unrecognized flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/i);
  });
});

describe('buildJobs', () => {
  it('orders candle jobs before snapshot jobs, symbol outer and interval inner', () => {
    const jobs = buildJobs(parseArgs([
      '--symbols', 'BTCUSDT,ETHUSDT',
      '--candles', '1h:6,1d:12',
      '--snapshots', '4h:6',
    ]));

    expect(jobs).toEqual<Job[]>([
      { kind: 'candles', symbol: 'BTCUSDT', interval: '1h', months: 6 },
      { kind: 'candles', symbol: 'BTCUSDT', interval: '1d', months: 12 },
      { kind: 'candles', symbol: 'ETHUSDT', interval: '1h', months: 6 },
      { kind: 'candles', symbol: 'ETHUSDT', interval: '1d', months: 12 },
      { kind: 'snapshots', symbol: 'BTCUSDT', interval: '4h', months: 6 },
      { kind: 'snapshots', symbol: 'ETHUSDT', interval: '4h', months: 6 },
    ]);
  });

  it('omits candle jobs with --skip-candles', () => {
    const jobs = buildJobs(parseArgs(['--symbols', 'BTCUSDT', '--skip-candles', '--snapshots', '1h:6']));

    expect(jobs.every((j) => j.kind === 'snapshots')).toBe(true);
    expect(jobs).toHaveLength(1);
  });

  it('omits snapshot jobs with --skip-snapshots', () => {
    const jobs = buildJobs(parseArgs(['--symbols', 'BTCUSDT', '--skip-snapshots', '--candles', '1h:6']));

    expect(jobs.every((j) => j.kind === 'candles')).toBe(true);
    expect(jobs).toHaveLength(1);
  });
});

describe('main', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'backfill-history.ts']);
    vi.useFakeTimers();

    mockConnectDB.mockReset().mockResolvedValue(undefined);
    mockBackfillCandles.mockReset().mockResolvedValue({ inserted: 10, total: 100 });
    mockGetCandleRange.mockReset().mockResolvedValue({ oldest: 1, newest: 2, count: 100 });
    mockFetchFundingHistory.mockReset().mockResolvedValue([]);
    mockLoadFearGreedLookup.mockReset().mockResolvedValue(() => null);
    mockBackfillSnapshotRange.mockReset().mockResolvedValue({
      snapshots: 50,
      coverage: { fundingRate: 0, longShortRatio: 0, openInterest: 0, fearGreed: 0 },
    });
    mockUpdateMany.mockReset().mockResolvedValue({ modifiedCount: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function parsedLogs() {
    return logs.map((line) => JSON.parse(line));
  }

  /** The run pauses a second between jobs; drive fake timers while it runs. */
  async function run() {
    const promise = main();
    await vi.runAllTimersAsync();
    return promise;
  }

  it('dry-run prints the job list and exits 0 without connecting', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--candles', '1h:6',
      '--snapshots', '4h:6',
      '--dry-run',
    ]);

    const code = await run();

    expect(code).toBe(0);
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(parsedLogs()).toEqual([
      { kind: 'candles', symbol: 'BTCUSDT', interval: '1h', months: 6 },
      { kind: 'snapshots', symbol: 'BTCUSDT', interval: '4h', months: 6 },
    ]);
  });

  it('connects, unsets the 5m TTL, and logs the modified count', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--candles', '1h:6',
      '--skip-snapshots',
      '--unset-5m-ttl',
    ]);
    mockUpdateMany.mockResolvedValue({ modifiedCount: 42 });

    await run();

    expect(mockConnectDB).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { interval: '5m', expiresAt: { $exists: true } },
      { $unset: { expiresAt: 1 } }
    );
    expect(parsedLogs()).toContainEqual({ kind: 'unset-5m-ttl', modifiedCount: 42 });
  });

  it('runs candle jobs before snapshot jobs and logs one JSON line per job', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--candles', '1h:6',
      '--snapshots', '4h:6',
    ]);

    const code = await run();

    expect(code).toBe(0);
    expect(mockBackfillCandles).toHaveBeenCalledWith('BTCUSDT', '1h', 6);
    expect(mockBackfillSnapshotRange).toHaveBeenCalledTimes(1);

    const [candleLog, snapshotLog] = parsedLogs();
    expect(candleLog).toMatchObject({
      kind: 'candles', symbol: 'BTCUSDT', interval: '1h', months: 6,
      inserted: 10, count: 100, from: 1, to: 2,
    });
    expect(typeof candleLog.ms).toBe('number');
    expect(snapshotLog).toMatchObject({
      kind: 'snapshots', symbol: 'BTCUSDT', interval: '4h', months: 6,
      snapshots: 50,
      coverage: { fundingRate: 0, longShortRatio: 0, openInterest: 0, fearGreed: 0 },
    });
    expect(typeof snapshotLog.ms).toBe('number');
  });

  it('pages funding once per symbol from that symbol largest snapshot window', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--skip-candles',
      '--snapshots', '1h:6,1d:12',
    ]);

    await run();

    expect(mockFetchFundingHistory).toHaveBeenCalledTimes(1);
    expect(mockFetchFundingHistory.mock.calls[0][0]).toBe('BTCUSDT');
    expect(mockLoadFearGreedLookup).toHaveBeenCalledTimes(1);
    expect(mockLoadFearGreedLookup).toHaveBeenCalledWith(12 * 31 + 3);
  });

  it('continues after a failing job, logs its error, and exits 1', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT,ETHUSDT',
      '--candles', '1h:6',
      '--skip-snapshots',
    ]);
    mockBackfillCandles
      .mockRejectedValueOnce(new Error('Binance 418'))
      .mockResolvedValue({ inserted: 5, total: 50 });

    const code = await run();

    expect(code).toBe(1);
    expect(mockBackfillCandles).toHaveBeenCalledTimes(2);
    const parsed = parsedLogs();
    expect(parsed[0]).toMatchObject({
      kind: 'candles', symbol: 'BTCUSDT', interval: '1h', months: 6, error: 'Binance 418',
    });
    expect(parsed[1]).toMatchObject({ kind: 'candles', symbol: 'ETHUSDT', interval: '1h', months: 6 });
  });

  it('returns 0 when every job succeeds', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--candles', '1h:6',
      '--skip-snapshots',
    ]);

    expect(await run()).toBe(0);
  });
});
