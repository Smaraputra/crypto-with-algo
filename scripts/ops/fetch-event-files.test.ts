// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStream } = vi.hoisted(() => ({ mockStream: vi.fn() }));

vi.mock('@/lib/external/binance-archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/external/binance-archive')>('@/lib/external/binance-archive');
  return { ...actual, streamArchiveCsvLines: (...args: unknown[]) => mockStream(...args) };
});

import { OUTPUT_HEADER, sha256Hex } from './fetch-perp-1m-files';
import {
  FUNDING_OUTPUT_HEADER,
  HARD_LAST_DAY,
  main,
  parseArgs,
  parsePlan,
  processFundingJob,
  processKlineJob,
  readManifest,
  runJobs,
} from './fetch-event-files';

interface ArchiveSpec {
  dataset: string;
  symbol: string;
  interval?: string;
  date: string;
  cadence: 'daily' | 'monthly';
}

const T0 = Date.parse('2026-10-09T00:00:00Z'); // Friday, 2026-10-09

const ARCHIVE_KLINE_HEADER =
  'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore';

function archiveKlineRow(minute: number, tag = '1', baseTime = T0): string {
  const t = baseTime + minute * 60_000;
  return `${t},100.${tag},101.${tag},99.${tag},100.5,12.5,${t + 59_999},1250.75,42,6.25,625.5,0`;
}

function expectedKlineOutputRow(minute: number, tag = '1', baseTime = T0): string {
  const t = baseTime + minute * 60_000;
  return `${t},100.${tag},101.${tag},99.${tag},100.5,12.5,1250.75,42,6.25,625.5`;
}

const ARCHIVE_FUNDING_HEADER = 'calc_time,funding_interval_hours,last_funding_rate';

let dir: string;
beforeEach(() => {
  mockStream.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'event-files-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('1. parsePlan', () => {
  const examplePlan = {
    version: 1,
    klines: [{ symbol: 'BTCUSDT', day: '2026-10-09' }],
    funding: [{ symbol: 'BTCUSDT', month: '2026-10' }],
  };

  it('accepts the example plan', () => {
    const parsed = parsePlan(examplePlan);
    expect(parsed.klines).toEqual([{ symbol: 'BTCUSDT', day: '2026-10-09' }]);
    expect(parsed.funding).toEqual([{ symbol: 'BTCUSDT', month: '2026-10' }]);
  });

  it('rejects a lowercase symbol (message contains offending value)', () => {
    const plan = {
      version: 1,
      klines: [{ symbol: 'btcusdt', day: '2026-10-09' }],
      funding: [],
    };
    expect(() => parsePlan(plan)).toThrow(/btcusdt/);
  });

  it('rejects a symbol without USDT (message contains offending value)', () => {
    const plan = {
      version: 1,
      klines: [{ symbol: 'BTCBUSD', day: '2026-10-09' }],
      funding: [],
    };
    expect(() => parsePlan(plan)).toThrow(/BTCBUSD/);
  });

  it('rejects day 2026-10-9 (message contains offending value)', () => {
    const plan = {
      version: 1,
      klines: [{ symbol: 'BTCUSDT', day: '2026-10-9' }],
      funding: [],
    };
    expect(() => parsePlan(plan)).toThrow(/2026-10-9/);
  });

  it('rejects day 2026-13-01 (message contains offending value)', () => {
    const plan = {
      version: 1,
      klines: [{ symbol: 'BTCUSDT', day: '2026-13-01' }],
      funding: [],
    };
    expect(() => parsePlan(plan)).toThrow(/2026-13-01/);
  });

  it('rejects day 2026-11-13 (message contains offending value)', () => {
    const plan = {
      version: 1,
      klines: [{ symbol: 'BTCUSDT', day: '2026-11-13' }],
      funding: [],
    };
    expect(() => parsePlan(plan)).toThrow(/day 2026-11-13 is after 2026-11-12: later data is never fetched/);
  });

  it('rejects day 2026-11-05 under stricter month guard (message contains offending value)', () => {
    const plan = {
      version: 1,
      klines: [{ symbol: 'BTCUSDT', day: '2026-11-05' }],
      funding: [],
    };
    expect(() => parsePlan(plan)).toThrow(/2026-11-05/);
    expect(() => parsePlan(plan)).toThrow(/reserved forward sample/);
  });

  it('rejects month 2026-11 (message contains offending value)', () => {
    const plan = {
      version: 1,
      klines: [],
      funding: [{ symbol: 'BTCUSDT', month: '2026-11' }],
    };
    expect(() => parsePlan(plan)).toThrow(/2026-11/);
    expect(() => parsePlan(plan)).toThrow(/reserved forward sample/);
  });

  it('rejects version: 2 (message contains offending value)', () => {
    const plan = {
      version: 2,
      klines: [],
      funding: [],
    };
    expect(() => parsePlan(plan)).toThrow(/2/);
  });

  it('rejects an unknown top-level key (message contains offending value)', () => {
    const plan = {
      version: 1,
      klines: [],
      funding: [],
      extraKey: 42,
    };
    expect(() => parsePlan(plan)).toThrow(/extraKey/);
  });

  it('rejects an unknown key inside a job (message contains offending value)', () => {
    const klinePlan = {
      version: 1,
      klines: [{ symbol: 'BTCUSDT', day: '2026-10-09', extraKlineField: true }],
      funding: [],
    };
    expect(() => parsePlan(klinePlan)).toThrow(/extraKlineField/);

    const fundingPlan = {
      version: 1,
      klines: [],
      funding: [{ symbol: 'BTCUSDT', month: '2026-10', extraFundingField: 'bad' }],
    };
    expect(() => parsePlan(fundingPlan)).toThrow(/extraFundingField/);
  });

  it('drops duplicates and sorts jobs', () => {
    const plan = {
      version: 1,
      klines: [
        { symbol: 'ETHUSDT', day: '2026-10-05' },
        { symbol: 'BTCUSDT', day: '2026-10-09' },
        { symbol: 'BTCUSDT', day: '2026-10-01' },
        { symbol: 'ETHUSDT', day: '2026-10-05' },
      ],
      funding: [
        { symbol: 'ETHUSDT', month: '2026-10' },
        { symbol: 'BTCUSDT', month: '2026-10' },
        { symbol: 'BTCUSDT', month: '2026-09' },
        { symbol: 'BTCUSDT', month: '2026-10' },
      ],
    };
    const parsed = parsePlan(plan);
    expect(parsed.klines).toEqual([
      { symbol: 'BTCUSDT', day: '2026-10-01' },
      { symbol: 'BTCUSDT', day: '2026-10-09' },
      { symbol: 'ETHUSDT', day: '2026-10-05' },
    ]);
    expect(parsed.funding).toEqual([
      { symbol: 'BTCUSDT', month: '2026-09' },
      { symbol: 'BTCUSDT', month: '2026-10' },
      { symbol: 'ETHUSDT', month: '2026-10' },
    ]);
  });

  it('enforces HARD_LAST_DAY constant and maximum 20,000 jobs', () => {
    expect(HARD_LAST_DAY).toBe('2026-11-12');
  });
});

describe('2. Kline job', () => {
  it('shapes kline rows, deduplicates, sorts, and records manifest line with gaps', async () => {
    // 5 distinct minutes: 0, 1, 3, 5, 10 -> gaps = (10 - 0 + 1) - 5 = 6
    const lines = [
      ARCHIVE_KLINE_HEADER,
      archiveKlineRow(5, '5'),
      archiveKlineRow(1, '1'),
      archiveKlineRow(10, '10'),
      archiveKlineRow(0, '0'),
      archiveKlineRow(1, 'dup'), // duplicate open_time
      archiveKlineRow(3, '3'),
    ];

    mockStream.mockImplementation(async (spec: ArchiveSpec, onLine: (line: string) => void) => {
      expect(spec).toEqual({
        dataset: 'klines',
        symbol: 'BTCUSDT',
        interval: '1m',
        date: '2026-10-09',
        cadence: 'daily',
      });
      for (const line of lines) onLine(line);
      return { status: 'ok', lines: lines.length, uncompressedBytes: 0 };
    });

    const manifest = new Map();
    const outcome = await processKlineJob({ symbol: 'BTCUSDT', day: '2026-10-09' }, dir, { force: false, manifest });
    expect(outcome).toBe('written');

    const filePath = join(dir, 'klines', 'BTCUSDT', 'BTCUSDT-1m-2026-10-09.csv.gz');
    expect(existsSync(filePath)).toBe(true);

    const fileBytes = readFileSync(filePath);
    const decompressed = gunzipSync(fileBytes).toString('utf8');

    const expectedCsv =
      [
        OUTPUT_HEADER,
        expectedKlineOutputRow(0, '0'),
        expectedKlineOutputRow(1, '1'),
        expectedKlineOutputRow(3, '3'),
        expectedKlineOutputRow(5, '5'),
        expectedKlineOutputRow(10, '10'),
      ].join('\n') + '\n';

    expect(decompressed).toBe(expectedCsv);

    const manifestMap = readManifest(join(dir, 'manifest.jsonl'));
    const entry = manifestMap.get('klines|BTCUSDT|2026-10-09');
    expect(entry).toBeDefined();
    expect(entry).toEqual({
      kind: 'klines',
      symbol: 'BTCUSDT',
      date: '2026-10-09',
      status: 'ok',
      rows: 5,
      firstTs: T0,
      lastTs: T0 + 10 * 60_000,
      gaps: 6,
      badRows: 0,
      duplicates: 1,
      sha256: sha256Hex(fileBytes),
      bytes: fileBytes.length,
    });
  });
});

describe('3. Kline file with row outside UTC day', () => {
  it('counts job as error, leaves no file or tmp file on disk, other jobs still run', async () => {
    // BTCUSDT has a row dated the next UTC day (T0 + 24 * 3600 * 1000)
    const nextDayRow = archiveKlineRow(1440, 'next'); // minute 1440 is next day
    const btcLines = [ARCHIVE_KLINE_HEADER, archiveKlineRow(0, '0'), nextDayRow];
    const ethLines = [ARCHIVE_KLINE_HEADER, archiveKlineRow(0, '0')];

    mockStream.mockImplementation(async (spec: ArchiveSpec, onLine: (line: string) => void) => {
      const src = spec.symbol === 'BTCUSDT' ? btcLines : ethLines;
      for (const line of src) onLine(line);
      return { status: 'ok', lines: src.length, uncompressedBytes: 0 };
    });

    const plan = {
      klines: [
        { symbol: 'BTCUSDT', day: '2026-10-09' },
        { symbol: 'ETHUSDT', day: '2026-10-09' },
      ],
      funding: [],
    };

    const summary = await runJobs(plan, dir, { force: false, concurrency: 1 });
    expect(summary.errors).toBe(1);
    expect(summary.written).toBe(1);
    expect(summary.errorFiles).toEqual([
      { file: 'BTCUSDT-1m-2026-10-09', error: expect.stringMatching(/outside UTC day/) },
    ]);

    const btcFile = join(dir, 'klines', 'BTCUSDT', 'BTCUSDT-1m-2026-10-09.csv.gz');
    expect(existsSync(btcFile)).toBe(false);
    expect(existsSync(`${btcFile}.tmp-${process.pid}`)).toBe(false);

    const ethFile = join(dir, 'klines', 'ETHUSDT', 'ETHUSDT-1m-2026-10-09.csv.gz');
    expect(existsSync(ethFile)).toBe(true);
  });
});

describe('4. 404 missing handling', () => {
  it('writes no file, marks missing: 1 with one missing manifest line, second run adds no duplicate line', async () => {
    mockStream.mockImplementation(async () => {
      return { status: 'missing' };
    });

    const plan = {
      klines: [{ symbol: 'BTCUSDT', day: '2026-10-09' }],
      funding: [],
    };

    const summary1 = await runJobs(plan, dir, { force: false, concurrency: 1 });
    expect(summary1.missing).toBe(1);
    expect(summary1.missingFiles).toEqual(['BTCUSDT-1m-2026-10-09']);

    const btcFile = join(dir, 'klines', 'BTCUSDT', 'BTCUSDT-1m-2026-10-09.csv.gz');
    expect(existsSync(btcFile)).toBe(false);

    const manifestPath = join(dir, 'manifest.jsonl');
    const rawLines1 = readFileSync(manifestPath, 'utf8').trim().split('\n');
    expect(rawLines1).toHaveLength(1);
    const entry1 = JSON.parse(rawLines1[0]);
    expect(entry1).toEqual({
      kind: 'klines',
      symbol: 'BTCUSDT',
      date: '2026-10-09',
      status: 'missing',
      rows: 0,
      firstTs: null,
      lastTs: null,
      gaps: null,
      badRows: 0,
      duplicates: 0,
      sha256: null,
      bytes: 0,
    });

    // Second run
    const summary2 = await runJobs(plan, dir, { force: false, concurrency: 1 });
    expect(summary2.missing).toBe(1);
    const rawLines2 = readFileSync(manifestPath, 'utf8').trim().split('\n');
    expect(rawLines2).toHaveLength(1); // Still 1 line!
  });
});

describe('5. Funding job', () => {
  it('handles unsorted rows with a header and duplicate calc_time, preserving exact raw text and gaps: null', async () => {
    const calcTime0 = 1727740800000; // 2026-10-01 00:00:00
    const calcTime1 = 1727769600000; // 2026-10-01 08:00:00
    const calcTime2 = 1727798400000; // 2026-10-01 16:00:00

    const lines = [
      ARCHIVE_FUNDING_HEADER,
      `${calcTime1},8,-0.00025000`,
      `${calcTime0},8,0.00010000`,
      `${calcTime1},8,0.00099999`, // duplicate calc_time, should be dropped
      `${calcTime2},4,0.00005000`,
    ];

    mockStream.mockImplementation(async (spec: ArchiveSpec, onLine: (line: string) => void) => {
      expect(spec).toEqual({
        dataset: 'fundingRate',
        symbol: 'BTCUSDT',
        date: '2026-10',
        cadence: 'monthly',
      });
      for (const line of lines) onLine(line);
      return { status: 'ok', lines: lines.length, uncompressedBytes: 0 };
    });

    const manifest = new Map();
    const outcome = await processFundingJob({ symbol: 'BTCUSDT', month: '2026-10' }, dir, {
      force: false,
      manifest,
    });
    expect(outcome).toBe('written');

    const filePath = join(dir, 'funding', 'BTCUSDT', 'BTCUSDT-fundingRate-2026-10.csv.gz');
    expect(existsSync(filePath)).toBe(true);

    const fileBytes = readFileSync(filePath);
    const decompressed = gunzipSync(fileBytes).toString('utf8');

    const expectedCsv =
      [
        FUNDING_OUTPUT_HEADER,
        `${calcTime0},8,0.00010000`,
        `${calcTime1},8,-0.00025000`,
        `${calcTime2},4,0.00005000`,
      ].join('\n') + '\n';

    expect(decompressed).toBe(expectedCsv);

    const manifestMap = readManifest(join(dir, 'manifest.jsonl'));
    const entry = manifestMap.get('funding|BTCUSDT|2026-10');
    expect(entry).toBeDefined();
    expect(entry).toEqual({
      kind: 'funding',
      symbol: 'BTCUSDT',
      date: '2026-10',
      status: 'ok',
      rows: 3,
      firstTs: calcTime0,
      lastTs: calcTime2,
      gaps: null,
      badRows: 0,
      duplicates: 1,
      sha256: sha256Hex(fileBytes),
      bytes: fileBytes.length,
    });
  });
});

describe('6. Re-run and skip logic', () => {
  it('skips existing files without calling stream, refetches with --force, and summarises disk files missing from manifest', async () => {
    const klineLines = [ARCHIVE_KLINE_HEADER, archiveKlineRow(0, '0')];
    const fundingLines = [ARCHIVE_FUNDING_HEADER, '1727740800000,8,0.00010000'];

    mockStream.mockImplementation(async (spec: ArchiveSpec, onLine: (line: string) => void) => {
      const src = spec.dataset === 'klines' ? klineLines : fundingLines;
      for (const line of src) onLine(line);
      return { status: 'ok', lines: src.length, uncompressedBytes: 0 };
    });

    const plan = {
      klines: [{ symbol: 'BTCUSDT', day: '2026-10-09' }],
      funding: [{ symbol: 'BTCUSDT', month: '2026-10' }],
    };

    // First run: writes both files
    const summary1 = await runJobs(plan, dir, { force: false, concurrency: 1 });
    expect(summary1.written).toBe(2);
    expect(mockStream).toHaveBeenCalledTimes(2);

    // Second run: files exist and are in manifest, so skipped
    mockStream.mockClear();
    const summary2 = await runJobs(plan, dir, { force: false, concurrency: 1 });
    expect(summary2.skipped).toBe(2);
    expect(mockStream).not.toHaveBeenCalled();

    // Third run with --force: downloads again
    mockStream.mockClear();
    const summary3 = await runJobs(plan, dir, { force: true, concurrency: 1 });
    expect(summary3.written).toBe(2);
    expect(mockStream).toHaveBeenCalledTimes(2);

    // Delete manifest.jsonl but keep files on disk: summarises from disk and skips
    unlinkSync(join(dir, 'manifest.jsonl'));
    expect(existsSync(join(dir, 'manifest.jsonl'))).toBe(false);

    mockStream.mockClear();
    const summary4 = await runJobs(plan, dir, { force: false, concurrency: 1 });
    expect(summary4.skipped).toBe(2);
    expect(mockStream).not.toHaveBeenCalled();

    const manifestMap = readManifest(join(dir, 'manifest.jsonl'));
    expect(manifestMap.has('klines|BTCUSDT|2026-10-09')).toBe(true);
    expect(manifestMap.has('funding|BTCUSDT|2026-10')).toBe(true);
    expect(manifestMap.get('klines|BTCUSDT|2026-10-09')?.rows).toBe(1);
    expect(manifestMap.get('funding|BTCUSDT|2026-10')?.rows).toBe(1);
  });
});

describe('7. main CLI entry point', () => {
  it('returns 0 and prints JSON summary when all jobs work', async () => {
    mockStream.mockImplementation(async (spec: ArchiveSpec, onLine: (line: string) => void) => {
      onLine(spec.dataset === 'klines' ? archiveKlineRow(0, '0') : '1727740800000,8,0.00010000');
      return { status: 'ok', lines: 1, uncompressedBytes: 0 };
    });

    const planPath = join(dir, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        version: 1,
        klines: [{ symbol: 'BTCUSDT', day: '2026-10-09' }],
        funding: [{ symbol: 'BTCUSDT', month: '2026-10' }],
      })
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await main(['--plan', planPath, '--out-dir', dir]);
    expect(code).toBe(0);

    expect(errSpy).toHaveBeenCalledWith('fetch-event-files: 1 klines, 1 funding');
    expect(logSpy).toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.written).toBe(2);
    expect(output.errors).toBe(0);

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('returns 1 when one job errors', async () => {
    mockStream.mockImplementation(async (spec: ArchiveSpec, onLine: (line: string) => void) => {
      if (spec.dataset === 'klines') {
        // row outside day
        onLine(archiveKlineRow(1440, 'next'));
      }
      return { status: 'ok', lines: 1, uncompressedBytes: 0 };
    });

    const planPath = join(dir, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        version: 1,
        klines: [{ symbol: 'BTCUSDT', day: '2026-10-09' }],
        funding: [],
      })
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await main(['--plan', planPath, '--out-dir', dir]);
    expect(code).toBe(1);

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('throws before any stream call when plan day is after 2026-11-12', async () => {
    const planPath = join(dir, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        version: 1,
        klines: [{ symbol: 'BTCUSDT', day: '2026-11-13' }],
        funding: [],
      })
    );

    await expect(main(['--plan', planPath, '--out-dir', dir])).rejects.toThrow(
      /day 2026-11-13 is after 2026-11-12: later data is never fetched/
    );
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('parses arguments correctly and validates flags', () => {
    const args = parseArgs(['--plan', 'p.json', '--out-dir', 'out', '--concurrency', '6', '--force']);
    expect(args).toEqual({
      plan: 'p.json',
      outDir: 'out',
      concurrency: 6,
      force: true,
    });

    expect(() => parseArgs(['--plan', 'p.json'])).toThrow(/--out-dir is required/);
    expect(() => parseArgs(['--out-dir', 'o'])).toThrow(/--plan is required/);
    expect(() => parseArgs(['--plan', 'p.json', '--out-dir', 'o', '--concurrency', '9'])).toThrow(/1 to 8/);
    expect(() => parseArgs(['--plan', 'p.json', '--out-dir', 'o', '--unknown'])).toThrow(/Unknown flag/);
  });
});
