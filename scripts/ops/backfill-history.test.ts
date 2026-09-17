import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockConnectDB,
  mockBackfillCandles,
  mockGetCandleRange,
  mockFetchFundingHistory,
  mockLoadFearGreedLookup,
  mockBackfillSnapshotRange,
  mockUpdateMany,
  mockSnapshotIndexes,
  mockSnapshotDropIndex,
} = vi.hoisted(() => ({
  mockConnectDB: vi.fn(),
  mockBackfillCandles: vi.fn(),
  mockGetCandleRange: vi.fn(),
  mockFetchFundingHistory: vi.fn(),
  mockLoadFearGreedLookup: vi.fn(),
  mockBackfillSnapshotRange: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockSnapshotIndexes: vi.fn(),
  mockSnapshotDropIndex: vi.fn(),
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
vi.mock('@/lib/models/historical-snapshot', () => ({
  HistoricalSnapshot: {
    collection: {
      indexes: (...args: unknown[]) => mockSnapshotIndexes(...args),
      dropIndex: (...args: unknown[]) => mockSnapshotDropIndex(...args),
    },
  },
}));

import { parseArgs, buildJobs, main, type Job } from './backfill-history';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Matches backfill-history.ts's own PAIR_DELAY_MS, which it does not export. */
const PAIR_DELAY_MS = 1000;

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
    expect(args.refill).toBe(false);
    expect(args.unsetFiveMinuteTtl).toBe(false);
    expect(args.dropSnapshotTtl).toBe(false);
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
      '--refill',
      '--unset-5m-ttl',
      '--drop-snapshot-ttl',
      '--dry-run',
    ]);

    expect(args.skipCandles).toBe(true);
    expect(args.skipSnapshots).toBe(true);
    expect(args.refill).toBe(true);
    expect(args.unsetFiveMinuteTtl).toBe(true);
    expect(args.dropSnapshotTtl).toBe(true);
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

  it('rejects a value-taking flag with no value at all', () => {
    expect(() => parseArgs(['--candles'])).toThrow(/--candles requires a value/);
  });

  it('rejects a value-taking flag whose value looks like another flag', () => {
    expect(() => parseArgs(['--candles', '--dry-run'])).toThrow(/--candles requires a value/);
    expect(() => parseArgs(['--symbols', '--skip-candles'])).toThrow(/--symbols requires a value/);
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
    mockSnapshotIndexes.mockReset().mockResolvedValue([]);
    mockSnapshotDropIndex.mockReset().mockResolvedValue(undefined);
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

  it('drops the snapshot TTL index by name when one exists', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--skip-candles',
      '--skip-snapshots',
      '--drop-snapshot-ttl',
    ]);
    mockSnapshotIndexes.mockResolvedValue([
      { v: 2, key: { symbol: 1, interval: 1, timestamp: -1 }, name: 'symbol_1_interval_1_timestamp_-1' },
      { v: 2, key: { createdAt: 1 }, name: 'createdAt_1', expireAfterSeconds: 31536000 },
    ]);

    await run();

    expect(mockSnapshotIndexes).toHaveBeenCalledTimes(1);
    expect(mockSnapshotDropIndex).toHaveBeenCalledWith('createdAt_1');
    expect(parsedLogs()).toContainEqual({
      kind: 'migration',
      action: 'drop-snapshot-ttl',
      dropped: 'createdAt_1',
    });
  });

  it('is idempotent: logs dropped null and skips dropIndex when no TTL index exists', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--skip-candles',
      '--skip-snapshots',
      '--drop-snapshot-ttl',
    ]);
    mockSnapshotIndexes.mockResolvedValue([
      { v: 2, key: { symbol: 1, interval: 1, timestamp: -1 }, name: 'symbol_1_interval_1_timestamp_-1' },
    ]);

    await run();

    expect(mockSnapshotDropIndex).not.toHaveBeenCalled();
    expect(parsedLogs()).toContainEqual({
      kind: 'migration',
      action: 'drop-snapshot-ttl',
      dropped: null,
    });
  });

  it('does not inspect snapshot indexes without --drop-snapshot-ttl', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--skip-candles',
      '--skip-snapshots',
    ]);

    await run();

    expect(mockSnapshotIndexes).not.toHaveBeenCalled();
    expect(mockSnapshotDropIndex).not.toHaveBeenCalled();
  });

  it('warns that --unset-5m-ttl must run only after the app is redeployed', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--skip-candles', '--skip-snapshots',
      '--unset-5m-ttl',
    ]);

    await run();

    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/redeployed from this branch/i));
  });

  it('warns that --drop-snapshot-ttl must run only after the app is redeployed', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--skip-candles', '--skip-snapshots',
      '--drop-snapshot-ttl',
    ]);

    await run();

    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/redeployed from this branch/i));
  });

  it('does not warn when neither TTL migration flag is used', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--skip-candles', '--skip-snapshots',
    ]);

    await run();

    expect(console.error).not.toHaveBeenCalled();
  });

  it('catches a failing --unset-5m-ttl, logs a migration error, fails the run, and still runs jobs', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--candles', '1h:6',
      '--skip-snapshots',
      '--unset-5m-ttl',
    ]);
    mockUpdateMany.mockRejectedValue(new Error('Mongo down'));

    const code = await run();

    expect(code).toBe(1);
    expect(mockBackfillCandles).toHaveBeenCalledWith('BTCUSDT', '1h', 6);
    expect(parsedLogs()).toContainEqual({
      kind: 'migration', action: 'unset-5m-ttl', error: 'Mongo down',
    });
  });

  it('catches a failing --drop-snapshot-ttl, logs a migration error, fails the run, and still runs jobs', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--candles', '1h:6',
      '--skip-snapshots',
      '--drop-snapshot-ttl',
    ]);
    mockSnapshotIndexes.mockRejectedValue(new Error('Mongo down'));

    const code = await run();

    expect(code).toBe(1);
    expect(mockBackfillCandles).toHaveBeenCalledWith('BTCUSDT', '1h', 6);
    expect(parsedLogs()).toContainEqual({
      kind: 'migration', action: 'drop-snapshot-ttl', error: 'Mongo down',
    });
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

  it('reports requestedFrom, from, and complete: true when the stored range reaches the request', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--candles', '1h:6',
      '--skip-snapshots',
    ]);
    const now = Date.now();
    mockGetCandleRange.mockResolvedValue({ oldest: now - 7 * 30 * DAY_MS, newest: now, count: 100 });

    await run();

    const [candleLog] = parsedLogs();
    expect(candleLog.requestedFrom).toBe(now - 6 * 30 * DAY_MS);
    expect(candleLog.from).toBe(now - 7 * 30 * DAY_MS);
    expect(candleLog.complete).toBe(true);
    expect(candleLog.refill).toBe(false);
  });

  it('reports complete: false when the stored range does not reach the requested start', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--candles', '1h:6',
      '--skip-snapshots',
    ]);
    const now = Date.now();
    // fetchKlinesRange's 120s deadline truncated the fetch to 5 of the 6
    // requested months.
    mockGetCandleRange.mockResolvedValue({ oldest: now - 5 * 30 * DAY_MS, newest: now, count: 100 });

    await run();

    const [candleLog] = parsedLogs();
    expect(candleLog.complete).toBe(false);
  });

  it('reports complete: false when nothing is stored at all', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--candles', '1h:6',
      '--skip-snapshots',
    ]);
    mockGetCandleRange.mockResolvedValue({ oldest: null, newest: null, count: 0 });

    await run();

    const [candleLog] = parsedLogs();
    expect(candleLog.complete).toBe(false);
  });

  it('passes refill through to backfillCandles and the log line when --refill is set', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--candles', '1h:6',
      '--skip-snapshots',
      '--refill',
    ]);
    // A refill reports inserted: 0 on success; getCandleRange's count is what
    // the log line should carry instead.
    mockBackfillCandles.mockResolvedValue({ inserted: 0, total: 100 });

    await run();

    expect(mockBackfillCandles).toHaveBeenCalledWith('BTCUSDT', '1h', 6, { refill: true });
    const [candleLog] = parsedLogs();
    expect(candleLog.refill).toBe(true);
    expect(candleLog.inserted).toBe(0);
    expect(candleLog.count).toBe(100);
  });

  it('pages funding once per symbol from that symbol largest snapshot window', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--skip-candles',
      '--snapshots', '1h:6,1d:12',
    ]);
    // Fake timers freeze Date.now() and only advance it when a scheduled
    // timer fires; the funding fetch happens before the first pause, so it
    // sees the same "now" captured here.
    const now = Date.now();

    await run();

    expect(mockFetchFundingHistory).toHaveBeenCalledTimes(1);
    const [symbolArg, startArg, endArg] = mockFetchFundingHistory.mock.calls[0];
    expect(symbolArg).toBe('BTCUSDT');
    // Largest snapshot months for BTCUSDT is 12 (1h:6, 1d:12); funding is
    // paged from 8h before that window to the run's "now".
    expect(startArg).toBe(now - 12 * 30 * DAY_MS - 8 * HOUR_MS);
    expect(endArg).toBe(now);
    expect(mockLoadFearGreedLookup).toHaveBeenCalledTimes(1);
    expect(mockLoadFearGreedLookup).toHaveBeenCalledWith(12 * 31 + 3);
  });

  it('still runs a symbol\'s snapshot jobs when its funding fetch fails, logs the failure, and exits 1', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT',
      '--skip-candles',
      '--snapshots', '1h:6,1d:12',
    ]);
    mockFetchFundingHistory.mockRejectedValue(new Error('Binance 418'));

    const code = await run();

    expect(code).toBe(1);
    // Snapshot jobs still ran, without funding, for a later re-run to fill in.
    expect(mockBackfillSnapshotRange).toHaveBeenCalledTimes(2);
    expect(mockBackfillSnapshotRange.mock.calls[0][0]).toMatchObject({ fundingEvents: [] });
    expect(mockBackfillSnapshotRange.mock.calls[1][0]).toMatchObject({ fundingEvents: [] });

    const parsed = parsedLogs();
    expect(parsed).toContainEqual({ kind: 'funding', symbol: 'BTCUSDT', error: 'Binance 418' });
    const snapshotLogs = parsed.filter((line) => line.kind === 'snapshots');
    expect(snapshotLogs).toHaveLength(2);
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

  it('still pauses after a failing job, so a rejection does not skip backoff', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node', 'backfill-history.ts',
      '--symbols', 'BTCUSDT,ETHUSDT',
      '--candles', '1h:6',
      '--skip-snapshots',
    ]);
    mockBackfillCandles
      .mockRejectedValueOnce(new Error('Binance 418'))
      .mockResolvedValue({ inserted: 5, total: 50 });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await run();

    const pauseCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === PAIR_DELAY_MS);
    // One pause per job, including the failed first one.
    expect(pauseCalls).toHaveLength(2);
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
