// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { mockConnectDB, mockFetchDvol, mockFetchOptionTrades, mockBulkUpsertOptionsFlow } = vi.hoisted(
  () => ({
    mockConnectDB: vi.fn(),
    mockFetchDvol: vi.fn(),
    mockFetchOptionTrades: vi.fn(),
    mockBulkUpsertOptionsFlow: vi.fn(),
  })
);

vi.mock('@/lib/mongodb', () => ({ connectDB: () => mockConnectDB() }));

vi.mock('@/lib/external/deribit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/external/deribit')>('@/lib/external/deribit');
  return {
    ...actual,
    fetchDvol: (...args: unknown[]) => mockFetchDvol(...args),
    fetchOptionTrades: (...args: unknown[]) => mockFetchOptionTrades(...args),
  };
});

vi.mock('@/lib/options-flow-store', () => ({
  bulkUpsertOptionsFlow: (...args: unknown[]) => mockBulkUpsertOptionsFlow(...args),
}));

import {
  DATASET_KINDS,
  buildJobs,
  doneMarkerPath,
  main,
  parseArgs,
} from './ingest-deribit';
import { OPTIONS_SLOT_MS } from '@/lib/options-flow';

const NOW = new Date('2026-09-28T09:00:00Z');

function trade(overrides: Partial<{
  timestamp: number;
  tradeId: string;
  tradeSeq: number;
  instrumentName: string;
  direction: 'buy' | 'sell';
  price: number;
  markPrice: number | null;
  iv: number | null;
  indexPrice: number;
  amount: number;
  contracts: number | null;
}> = {}) {
  return {
    timestamp: Date.UTC(2024, 0, 1, 10, 5, 0),
    tradeId: 't1',
    tradeSeq: 1,
    instrumentName: 'BTC-1JUL24-42000-C',
    direction: 'buy' as const,
    price: 0.05,
    markPrice: 0.051,
    iv: 60,
    indexPrice: 42000,
    amount: 1,
    contracts: 1,
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('defaults to both datasets, both currencies, dvol first internally', () => {
    const args = parseArgs([], NOW);
    expect(args.datasets).toEqual(['dvol', 'trades']);
    expect(args.currencies).toEqual(['BTC', 'ETH']);
    expect(args.cacheDir).toBe('data/deribit-cache');
    expect(args.ratePerSec).toBe(3);
    expect(args.refresh).toBe(false);
    expect(args.dryRun).toBe(false);
  });

  it('defaults --from to 2021-10-01 and --to to yesterday', () => {
    const args = parseArgs([], NOW);
    expect(new Date(args.fromMs).toISOString().slice(0, 10)).toBe('2021-10-01');
    expect(new Date(args.toMs).toISOString().slice(0, 10)).toBe('2026-09-27');
  });

  it('parses every flag', () => {
    const args = parseArgs(
      [
        '--datasets', 'trades',
        '--currencies', 'ETH',
        '--from', '2024-01-01',
        '--to', '2024-03-31',
        '--cache-dir', '/tmp/deribit',
        '--rate-per-sec', '5',
        '--refresh',
        '--dry-run',
      ],
      NOW
    );
    expect(args.datasets).toEqual(['trades']);
    expect(args.currencies).toEqual(['ETH']);
    expect(args.fromMs).toBe(Date.UTC(2024, 0, 1));
    expect(args.toMs).toBe(Date.UTC(2024, 2, 31));
    expect(args.cacheDir).toBe('/tmp/deribit');
    expect(args.ratePerSec).toBe(5);
    expect(args.refresh).toBe(true);
    expect(args.dryRun).toBe(true);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--bogus'], NOW)).toThrow(/Unknown flag "--bogus"/);
  });

  it('rejects an unknown dataset', () => {
    expect(() => parseArgs(['--datasets', 'bookTicker'], NOW)).toThrow(/unknown dataset "bookTicker"/);
    expect(DATASET_KINDS).toEqual(['dvol', 'trades']);
  });

  it('rejects an unknown currency', () => {
    expect(() => parseArgs(['--currencies', 'DOGE'], NOW)).toThrow(/unknown currency "DOGE"/);
  });

  it('rejects a malformed or impossible date', () => {
    expect(() => parseArgs(['--from', '2024-1-1'], NOW)).toThrow(/expected YYYY-MM-DD/);
    expect(() => parseArgs(['--to', 'yesterday'], NOW)).toThrow(/expected YYYY-MM-DD/);
  });

  it('rejects a --to before --from', () => {
    expect(() => parseArgs(['--from', '2024-06-01', '--to', '2024-01-01'], NOW)).toThrow(/is before --from/);
  });

  it('rejects a non-positive rate', () => {
    expect(() => parseArgs(['--rate-per-sec', '0'], NOW)).toThrow(/positive number/);
    expect(() => parseArgs(['--rate-per-sec', '-1'], NOW)).toThrow(/positive number/);
    expect(() => parseArgs(['--rate-per-sec', 'fast'], NOW)).toThrow(/positive number/);
  });
});

describe('buildJobs', () => {
  it('always orders dvol jobs before trades jobs, whatever the flag order', () => {
    const args = parseArgs(['--datasets', 'trades,dvol', '--currencies', 'BTC,ETH'], NOW);
    const jobs = buildJobs(args);
    expect(jobs.map((j) => `${j.kind}:${j.currency}`)).toEqual([
      'dvol:BTC', 'dvol:ETH', 'trades:BTC', 'trades:ETH',
    ]);
  });

  it('emits one job per currency for a single dataset', () => {
    const args = parseArgs(['--datasets', 'dvol', '--currencies', 'BTC'], NOW);
    expect(buildJobs(args)).toHaveLength(1);
  });

  it('carries the range onto every job', () => {
    const args = parseArgs(['--datasets', 'dvol', '--from', '2024-01-01', '--to', '2024-01-05'], NOW);
    const jobs = buildJobs(args);
    expect(jobs[0].fromMs).toBe(args.fromMs);
    expect(jobs[0].toMs).toBe(args.toMs);
  });
});

describe('doneMarkerPath', () => {
  it('builds <cacheDir>/trades/<CUR>/<day>.done', () => {
    expect(doneMarkerPath('data/deribit-cache', 'BTC', '2024-01-01')).toBe(
      join('data/deribit-cache', 'trades', 'BTC', '2024-01-01.done')
    );
  });
});

describe('main', () => {
  const logged: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let cacheDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    logged.length = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(line);
    });
    cacheDir = mkdtempSync(join(tmpdir(), 'ingest-deribit-'));
    mockBulkUpsertOptionsFlow.mockResolvedValue(0);
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.argv = ['node', 'ingest-deribit'];
    rmSync(cacheDir, { recursive: true, force: true });
  });

  function run(flags: string[]): Promise<number> {
    process.argv = ['node', 'ingest-deribit', '--cache-dir', cacheDir, ...flags];
    return main();
  }

  it('prints the job list and touches nothing on a dry run', async () => {
    const code = await run(['--dry-run', '--datasets', 'dvol', '--currencies', 'BTC']);
    expect(code).toBe(0);
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockFetchDvol).not.toHaveBeenCalled();
    expect(JSON.parse(logged[0])).toMatchObject({ kind: 'dvol', currency: 'BTC' });
  });

  it('derives minGapMs from --rate-per-sec and passes it to the client', async () => {
    mockFetchDvol.mockResolvedValue([]);
    await run(['--datasets', 'dvol', '--currencies', 'BTC', '--rate-per-sec', '4']);
    const options = mockFetchDvol.mock.calls[0][4];
    expect(options).toMatchObject({ minGapMs: Math.ceil(1000 / 4) });
  });

  it('runs a dvol job through fetchDvol, dvolUpserts and the store, writing exactly the four dvol fields', async () => {
    mockFetchDvol.mockResolvedValue([
      { timestamp: Date.UTC(2024, 0, 1), open: 58, high: 62, low: 57, close: 60 },
    ]);
    mockBulkUpsertOptionsFlow.mockResolvedValue(1);

    const code = await run([
      '--datasets', 'dvol', '--currencies', 'BTC', '--from', '2024-01-01', '--to', '2024-01-01',
    ]);

    expect(code).toBe(0);
    expect(mockConnectDB).toHaveBeenCalled();
    // toMs + DAY_MS, per the brief.
    expect(mockFetchDvol).toHaveBeenCalledWith(
      'BTC', Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 2), 3600, expect.any(Object)
    );

    const ops = mockBulkUpsertOptionsFlow.mock.calls[0][0];
    expect(ops).toHaveLength(1);
    expect(ops[0].filter).toEqual({ currency: 'BTC', timestamp: Date.UTC(2024, 0, 1) });
    expect(Object.keys(ops[0].set).sort()).toEqual(['dvolClose', 'dvolHigh', 'dvolLow', 'dvolOpen']);

    const summary = JSON.parse(logged[0]);
    expect(summary).toMatchObject({ kind: 'dvol', currency: 'BTC', hours: 1, written: 1 });
  });

  it('turns a fetched trades day into hourly upserts keyed on currency and hour open', async () => {
    mockFetchOptionTrades.mockResolvedValue([trade({ timestamp: Date.UTC(2024, 0, 1, 10, 5, 0) })]);
    mockBulkUpsertOptionsFlow.mockResolvedValue(1);

    const code = await run([
      '--datasets', 'trades', '--currencies', 'BTC', '--from', '2024-01-01', '--to', '2024-01-01',
    ]);

    expect(code).toBe(0);
    expect(mockFetchOptionTrades).toHaveBeenCalledWith(
      'BTC', Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 2) - 1, expect.any(Object)
    );

    const ops = mockBulkUpsertOptionsFlow.mock.calls[0][0];
    expect(ops).toHaveLength(1);
    const expectedHour = Math.floor(Date.UTC(2024, 0, 1, 10, 5, 0) / OPTIONS_SLOT_MS) * OPTIONS_SLOT_MS;
    expect(ops[0].filter).toEqual({ currency: 'BTC', timestamp: expectedHour });
    // Never a raw trade field: only the model's measure fields.
    const modelFields = [
      'callBuyNotional', 'callSellNotional', 'putBuyNotional', 'putSellNotional',
      'netDelta', 'netDollarGamma', 'tradeCount', 'greekTradeCount', 'vwIv', 'putIv25', 'callIv25',
    ];
    for (const key of Object.keys(ops[0].set)) {
      expect(modelFields).toContain(key);
    }

    const summary = JSON.parse(logged[0]);
    expect(summary).toMatchObject({ kind: 'trades', currency: 'BTC', days: 1, skipped: 0, fetched: 1, trades: 1 });
  });

  it('skips a day whose done marker exists and never calls the client for it', async () => {
    mkdirSync(join(cacheDir, 'trades', 'BTC'), { recursive: true });
    writeFileSync(join(cacheDir, 'trades', 'BTC', '2024-01-01.done'), '');

    const code = await run([
      '--datasets', 'trades', '--currencies', 'BTC', '--from', '2024-01-01', '--to', '2024-01-01',
    ]);

    expect(code).toBe(0);
    expect(mockFetchOptionTrades).not.toHaveBeenCalled();
    const summary = JSON.parse(logged[0]);
    expect(summary).toMatchObject({ days: 1, skipped: 1, fetched: 0 });
  });

  it('--refresh re-fetches a day that already has a done marker', async () => {
    mkdirSync(join(cacheDir, 'trades', 'BTC'), { recursive: true });
    writeFileSync(join(cacheDir, 'trades', 'BTC', '2024-01-01.done'), '');
    mockFetchOptionTrades.mockResolvedValue([]);

    const code = await run([
      '--datasets', 'trades', '--currencies', 'BTC', '--from', '2024-01-01', '--to', '2024-01-01', '--refresh',
    ]);

    expect(code).toBe(0);
    expect(mockFetchOptionTrades).toHaveBeenCalledTimes(1);
    const summary = JSON.parse(logged[0]);
    expect(summary).toMatchObject({ fetched: 1, skipped: 0 });
  });

  it('writes a done marker for a fully elapsed day but not for the current day', async () => {
    mockFetchOptionTrades.mockResolvedValue([]);

    // 2024-01-01 is long past NOW (2026-09-28): must get a marker.
    await run(['--datasets', 'trades', '--currencies', 'BTC', '--from', '2024-01-01', '--to', '2024-01-01']);
    expect(existsSync(join(cacheDir, 'trades', 'BTC', '2024-01-01.done'))).toBe(true);

    vi.clearAllMocks();
    mockFetchOptionTrades.mockResolvedValue([]);

    // "Today" relative to the real clock must not get a marker: it has not
    // fully elapsed yet.
    const today = new Date().toISOString().slice(0, 10);
    await run(['--datasets', 'trades', '--currencies', 'BTC', '--from', today, '--to', today]);
    expect(existsSync(join(cacheDir, 'trades', 'BTC', `${today}.done`))).toBe(false);
  });

  it('logs a heartbeat line every 25 days', async () => {
    mockFetchOptionTrades.mockResolvedValue([]);
    await run([
      '--datasets', 'trades', '--currencies', 'BTC', '--from', '2024-01-01', '--to', '2024-01-26',
    ]);
    const heartbeats = logged.map((l) => JSON.parse(l)).filter((l) => l.heartbeat === true);
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({ kind: 'trades', currency: 'BTC', index: 25, of: 26 });
  });

  it('logs a failing job, keeps going, and exits non-zero', async () => {
    mockFetchDvol.mockRejectedValueOnce(new Error('deribit unreachable'));
    mockFetchDvol.mockResolvedValueOnce([]);

    const code = await run([
      '--datasets', 'dvol', '--currencies', 'BTC,ETH', '--from', '2024-01-01', '--to', '2024-01-01',
    ]);

    expect(code).toBe(1);
    expect(JSON.parse(logged[0])).toMatchObject({ kind: 'dvol', currency: 'BTC', error: 'deribit unreachable' });
    expect(JSON.parse(logged[1])).toMatchObject({ kind: 'dvol', currency: 'ETH', hours: 0 });
  });
});
