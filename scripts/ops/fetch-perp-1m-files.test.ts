// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStream } = vi.hoisted(() => ({ mockStream: vi.fn() }));

vi.mock('@/lib/external/binance-archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/external/binance-archive')>('@/lib/external/binance-archive');
  return { ...actual, streamArchiveCsvLines: (...args: unknown[]) => mockStream(...args) };
});

import {
  MAX_MONTH,
  OUTPUT_HEADER,
  assertMonthAllowed,
  buildJobs,
  countGaps,
  enumerateMonthKeys,
  main,
  manifestEntry,
  manifestLine,
  outputPath,
  parseArgs,
  processFile,
  readManifest,
  needsRedo,
  runJobs,
  summariseOutputCsv,
  sha256Hex,
  shapeKlineLines,
  symbolsFromUniverse,
  assertDayAllowed,
  deficientDays,
  fetchDailyLines,
  findGapRanges,
  repairFromDaily,
  type StoredManifestEntry,
} from './fetch-perp-1m-files';

const T0 = 1_735_689_600_000; // 2025-01-01T00:00:00Z

/** Archive row: open_time, open, high, low, close, volume, close_time, quote_volume, count, taker_buy_volume, taker_buy_quote_volume, ignore. */
function archiveRow(minute: number, tag = '1'): string {
  const t = T0 + minute * 60_000;
  return `${t},100.${tag},101.${tag},99.${tag},100.5,12.5,${t + 59_999},1250.75,42,6.25,625.5,0`;
}

const ARCHIVE_HEADER =
  'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore';

let dir: string;
beforeEach(() => {
  mockStream.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'perp-1m-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface ArchiveSpec {
  symbol: string;
  date: string;
  cadence: 'daily' | 'monthly';
}

/**
 * Makes the mocked archive client deliver the given lines for every MONTHLY request, or report missing.
 * Daily requests are answered from `daily` by day, and are a 404 for any day not listed.
 */
function deliver(lines: string[] | 'missing', daily: Record<string, string[] | 'missing'> = {}): void {
  mockStream.mockImplementation(async (spec: ArchiveSpec, onLine: (line: string) => void) => {
    const source = spec.cadence === 'daily' ? (daily[spec.date] ?? 'missing') : lines;
    if (source === 'missing') return { status: 'missing' };
    for (const line of source) onLine(line);
    return { status: 'ok', lines: source.length, uncompressedBytes: 0 };
  });
}

function callsOf(cadence: 'daily' | 'monthly'): ArchiveSpec[] {
  return mockStream.mock.calls.map((c) => c[0] as ArchiveSpec).filter((spec) => spec.cadence === cadence);
}

describe('months and guard', () => {
  it('enumerates inclusive months across a year boundary', () => {
    expect(enumerateMonthKeys('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(enumerateMonthKeys('2026-10', '2026-10')).toEqual(['2026-10']);
  });

  it('defaults span 2025-01 to 2026-10 (22 months)', () => {
    const args = parseArgs(['--universe', 'u.json', '--out-dir', 'o']);
    expect(args.fromMonth).toBe('2025-01');
    expect(args.toMonth).toBe('2026-10');
    expect(enumerateMonthKeys(args.fromMonth, args.toMonth)).toHaveLength(22);
    expect(args.concurrency).toBe(4);
    expect(args.force).toBe(false);
  });

  it('refuses any month after 2026-10 with no override', () => {
    expect(MAX_MONTH).toBe('2026-10');
    expect(() => assertMonthAllowed('2026-11')).toThrow(/reserved forward sample/);
    expect(() => assertMonthAllowed('2027-01')).toThrow(/reserved forward sample/);
    expect(() => assertMonthAllowed('2026-10')).not.toThrow();
    expect(() => enumerateMonthKeys('2026-09', '2026-11')).toThrow(/reserved forward sample/);
    expect(() => parseArgs(['--universe', 'u', '--out-dir', 'o', '--to-month', '2026-11'])).toThrow(/reserved/);
    expect(() => parseArgs(['--universe', 'u', '--out-dir', 'o', '--from-month', '2026-12', '--to-month', '2026-10'])).toThrow(/reserved/);
    expect(() => parseArgs(['--universe', 'u', '--out-dir', 'o', '--force', '--to-month', '2026-11'])).toThrow(/reserved/);
  });

  it('rejects malformed months and reversed ranges', () => {
    expect(() => assertMonthAllowed('2026-13')).toThrow(/YYYY-MM/);
    expect(() => assertMonthAllowed('2026-1')).toThrow(/YYYY-MM/);
    expect(() => enumerateMonthKeys('2026-05', '2026-03')).toThrow(/after/);
  });

  it('the guard also runs before any download', async () => {
    await expect(processFile({ symbol: 'ETHUSDT', month: '2026-11' }, dir, { force: false, manifest: new Map() })).rejects.toThrow(
      /reserved forward sample/
    );
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('bounds concurrency to 1 through 8', () => {
    const base = ['--universe', 'u', '--out-dir', 'o'];
    expect(parseArgs([...base, '--concurrency', '8']).concurrency).toBe(8);
    expect(() => parseArgs([...base, '--concurrency', '9'])).toThrow(/1 to 8/);
    expect(() => parseArgs([...base, '--concurrency', '0'])).toThrow(/1 to 8/);
    expect(() => parseArgs([...base, '--bogus', '1'])).toThrow(/Unknown flag/);
    expect(() => parseArgs(['--universe', 'u'])).toThrow(/--out-dir is required/);
  });
});

describe('symbolsFromUniverse', () => {
  it('takes sorted unique binance symbols and skips null ones', () => {
    const json = {
      markets: [
        { coin: 'ETH', binanceSymbol: 'ETHUSDT' },
        { coin: 'BTC', binanceSymbol: 'BTCUSDT' },
        { coin: 'XYZ', binanceSymbol: null },
        { coin: 'ETH2', binanceSymbol: 'ETHUSDT' },
      ],
    };
    expect(symbolsFromUniverse(json)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('refuses a symbol that is not a contract shape, and a file without markets', () => {
    expect(() => symbolsFromUniverse({ markets: [{ binanceSymbol: '../ETHUSDT' }] })).toThrow(/not a USDT-M/);
    expect(() => symbolsFromUniverse({})).toThrow(/no markets/);
  });

  it('builds jobs symbol-major', () => {
    expect(buildJobs(['AUSDT', 'BUSDT'], ['2025-01', '2025-02'])).toEqual([
      { symbol: 'AUSDT', month: '2025-01' },
      { symbol: 'AUSDT', month: '2025-02' },
      { symbol: 'BUSDT', month: '2025-01' },
      { symbol: 'BUSDT', month: '2025-02' },
    ]);
  });
});

describe('shapeKlineLines', () => {
  it('shapes a headerless archive file to the ten output columns', () => {
    const shaped = shapeKlineLines([archiveRow(0), archiveRow(1)]);
    const [header, first] = shaped.csv.split('\n');
    expect(header).toBe(OUTPUT_HEADER);
    expect(first).toBe(`${T0},100.1,101.1,99.1,100.5,12.5,1250.75,42,6.25,625.5`);
    expect(shaped.rows).toBe(2);
    expect(shaped.csv.endsWith('\n')).toBe(true);
  });

  it('gives the same output with and without the archive header row', () => {
    const rows = [archiveRow(0), archiveRow(1), archiveRow(2)];
    const without = shapeKlineLines(rows);
    const withHeader = shapeKlineLines([ARCHIVE_HEADER, ...rows]);
    expect(withHeader.csv).toBe(without.csv);
    expect(withHeader.rows).toBe(3);
    expect(withHeader.badRows).toBe(0);
  });

  it('counts short rows and non-numeric open times as bad, and repeats as duplicates', () => {
    const shaped = shapeKlineLines([archiveRow(0), '123,1,2', 'abc,1,2,3,4,5,6,7,8,9,10,0', archiveRow(0), '', archiveRow(1)]);
    expect(shaped.rows).toBe(2);
    expect(shaped.badRows).toBe(2);
    expect(shaped.duplicates).toBe(1);
  });

  it('reports first, last and gaps', () => {
    const shaped = shapeKlineLines([archiveRow(0), archiveRow(1), archiveRow(4), archiveRow(5)]);
    expect(shaped.firstOpenTime).toBe(T0);
    expect(shaped.lastOpenTime).toBe(T0 + 5 * 60_000);
    expect(shaped.gaps).toBe(2);
  });

  it('handles an empty input', () => {
    const shaped = shapeKlineLines([ARCHIVE_HEADER]);
    expect(shaped).toMatchObject({ rows: 0, firstOpenTime: null, lastOpenTime: null, gaps: 0 });
    expect(shaped.csv).toBe(`${OUTPUT_HEADER}\n`);
  });
});

describe('summariseOutputCsv', () => {
  it('agrees with the statistics of the shaped file it re-reads', () => {
    const shaped = shapeKlineLines([archiveRow(0), archiveRow(1), archiveRow(5)]);
    const again = summariseOutputCsv(shaped.csv);
    expect(again).toMatchObject({ rows: 3, firstOpenTime: T0, lastOpenTime: T0 + 300_000, gaps: 3, badRows: 0, duplicates: 0 });
  });
});

describe('countGaps', () => {
  it('is zero for contiguous, short and unsorted contiguous series', () => {
    expect(countGaps([])).toBe(0);
    expect(countGaps([T0])).toBe(0);
    expect(countGaps([T0, T0 + 60_000, T0 + 120_000])).toBe(0);
    expect(countGaps([T0 + 120_000, T0, T0 + 60_000])).toBe(0);
  });

  it('counts every missing minute, including a long hole', () => {
    expect(countGaps([T0, T0 + 120_000])).toBe(1);
    expect(countGaps([T0, T0 + 60 * 60_000])).toBe(59);
  });
});

describe('manifest line', () => {
  it('carries the requested fields as one JSON line', () => {
    const shaped = shapeKlineLines([archiveRow(0), archiveRow(2)]);
    const entry = manifestEntry({ symbol: 'ETHUSDT', month: '2025-01' }, shaped, 'abc123');
    const line = manifestLine(entry);
    expect(line.includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({
      symbol: 'ETHUSDT',
      month: '2025-01',
      rows: 2,
      firstOpenTime: T0,
      lastOpenTime: T0 + 120_000,
      sha256: 'abc123',
      gaps: 1,
      gapRanges: [[T0 + 60_000, T0 + 60_000]],
      repairedDays: [],
      dailyMissing: [],
      conflicts: 0,
      badRows: 0,
      duplicates: 0,
    });
  });

  it('readManifest tolerates a missing file and a torn line, and the last line wins', () => {
    const path = join(dir, 'manifest.jsonl');
    expect(readManifest(path).size).toBe(0);
    writeFileSync(path, '{"symbol":"AUSDT","month":"2025-01","gaps":3}\n{"symbol":"AUSDT","month":"2025-01","gaps":0}\n{"symbol":"BUSD');
    const manifest = readManifest(path);
    expect([...manifest.keys()]).toEqual(['AUSDT|2025-01']);
    expect(manifest.get('AUSDT|2025-01')?.gaps).toBe(0);
  });
});

describe('processFile with a mocked archive client', () => {
  const job = { symbol: 'ETHUSDT', month: '2025-01' };

  it('requests the monthly 1m UM klines file for the symbol and month', async () => {
    deliver([archiveRow(0)]);
    await processFile(job, dir, { force: false, manifest: new Map() });
    expect(mockStream.mock.calls[0][0]).toEqual({
      dataset: 'klines',
      symbol: 'ETHUSDT',
      interval: '1m',
      date: '2025-01',
      cadence: 'monthly',
    });
  });

  it('writes a gzip file, a manifest line whose sha256 matches the file, and leaves no temp file', async () => {
    deliver([ARCHIVE_HEADER, archiveRow(0), archiveRow(1), archiveRow(3)]);
    const outcome = await processFile(job, dir, { force: false, manifest: new Map() });
    expect(outcome).toBe('written');

    const path = outputPath(dir, job);
    expect(path).toBe(join(dir, 'ETHUSDT', 'ETHUSDT-1m-2025-01.csv.gz'));
    const text = gunzipSync(readFileSync(path)).toString('utf8');
    expect(text.split('\n')[0]).toBe(OUTPUT_HEADER);
    expect(text.trim().split('\n')).toHaveLength(4);
    expect(readdirSync(join(dir, 'ETHUSDT'))).toEqual(['ETHUSDT-1m-2025-01.csv.gz']);

    const lines = readFileSync(join(dir, 'manifest.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ symbol: 'ETHUSDT', month: '2025-01', rows: 3, gaps: 1, firstOpenTime: T0, lastOpenTime: T0 + 180_000 });
    expect(entry.sha256).toBe(sha256Hex(readFileSync(path)));
  });

  it('writes byte-identical files for identical input', async () => {
    deliver([archiveRow(0), archiveRow(1)]);
    await processFile(job, dir, { force: false, manifest: new Map() });
    const first = sha256Hex(readFileSync(outputPath(dir, job)));
    await processFile(job, dir, { force: true, manifest: new Map() });
    expect(sha256Hex(readFileSync(outputPath(dir, job)))).toBe(first);
  });

  it('skips an existing non-empty file without calling the archive, unless forced', async () => {
    deliver([archiveRow(0)]);
    const keys = new Map<string, StoredManifestEntry>();
    await processFile(job, dir, { force: false, manifest: keys });
    mockStream.mockClear();

    expect(await processFile(job, dir, { force: false, manifest: keys })).toBe('skipped');
    expect(mockStream).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'manifest.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);

    expect(await processFile(job, dir, { force: true, manifest: keys })).toBe('written');
    expect(callsOf('monthly')).toHaveLength(1);
  });

  it('re-downloads a zero-size file', async () => {
    deliver([archiveRow(0)]);
    const path = outputPath(dir, job);
    mkdirSync(join(dir, 'ETHUSDT'), { recursive: true });
    writeFileSync(path, '');
    expect(await processFile(job, dir, { force: false, manifest: new Map() })).toBe('written');
    expect(readFileSync(path).length).toBeGreaterThan(0);
  });

  it('adds the manifest line for a skipped file that has none', async () => {
    deliver([archiveRow(0), archiveRow(1)]);
    await processFile(job, dir, { force: false, manifest: new Map() });
    rmSync(join(dir, 'manifest.jsonl'));
    mockStream.mockClear();

    expect(await processFile(job, dir, { force: false, manifest: new Map() })).toBe('skipped');
    expect(mockStream).not.toHaveBeenCalled();
    const entry = JSON.parse(readFileSync(join(dir, 'manifest.jsonl'), 'utf8').trim());
    expect(entry).toMatchObject({ symbol: 'ETHUSDT', month: '2025-01', rows: 2, gaps: 0 });
    expect(entry.sha256).toBe(sha256Hex(readFileSync(outputPath(dir, job))));
  });

  it('reports a 404 as missing and writes nothing', async () => {
    deliver('missing');
    expect(await processFile(job, dir, { force: false, manifest: new Map() })).toBe('missing');
    expect(existsSync(outputPath(dir, job))).toBe(false);
    expect(existsSync(join(dir, 'manifest.jsonl'))).toBe(false);
  });

  it('discards lines delivered before a restart', async () => {
    mockStream.mockImplementation(async (_spec: unknown, onLine: (line: string) => void, options: { onRestart: () => void }) => {
      onLine(archiveRow(0));
      options.onRestart();
      onLine(archiveRow(1));
      onLine(archiveRow(2));
      return { status: 'ok', lines: 3, uncompressedBytes: 0 };
    });
    await processFile(job, dir, { force: false, manifest: new Map() });
    const entry = JSON.parse(readFileSync(join(dir, 'manifest.jsonl'), 'utf8').trim());
    expect(entry.rows).toBe(2);
    expect(entry.firstOpenTime).toBe(T0 + 60_000);
  });

  it('throws when the file holds no usable rows and writes nothing', async () => {
    deliver([ARCHIVE_HEADER]);
    await expect(processFile(job, dir, { force: false, manifest: new Map() })).rejects.toThrow(/no usable rows/);
    expect(existsSync(outputPath(dir, job))).toBe(false);
  });
});

describe('runJobs summary', () => {
  it('tallies written, skipped, missing and errors without stopping on an error', async () => {
    mockStream.mockImplementation(async (spec: { symbol: string; date: string }, onLine: (line: string) => void) => {
      if (spec.symbol === 'NEWUSDT') return { status: 'missing' };
      if (spec.symbol === 'BADUSDT') throw new Error('HTTP 500');
      onLine(archiveRow(0));
      return { status: 'ok', lines: 1, uncompressedBytes: 0 };
    });

    const jobs = buildJobs(['BADUSDT', 'ETHUSDT', 'NEWUSDT'], ['2025-01', '2025-02']);
    const first = await runJobs(jobs, dir, { force: false, concurrency: 3 });
    expect(first).toMatchObject({ written: 2, skipped: 0, missing: 2, errors: 2 });
    expect(first.missingFiles).toEqual(['NEWUSDT-1m-2025-01', 'NEWUSDT-1m-2025-02']);
    expect(first.errorFiles.map((e) => e.file)).toEqual(['BADUSDT-1m-2025-01', 'BADUSDT-1m-2025-02']);
    expect(first.errorFiles[0].error).toBe('HTTP 500');

    const second = await runJobs(jobs, dir, { force: false, concurrency: 3 });
    expect(second).toMatchObject({ written: 0, skipped: 2, missing: 2, errors: 2 });
    expect(readFileSync(join(dir, 'manifest.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('main', () => {
  it('refuses a later month before touching the network or the disk', async () => {
    const universe = join(dir, 'u.json');
    writeFileSync(universe, JSON.stringify({ markets: [{ binanceSymbol: 'ETHUSDT' }] }));
    await expect(main(['--universe', universe, '--out-dir', join(dir, 'out'), '--to-month', '2026-11'])).rejects.toThrow(/reserved/);
    expect(mockStream).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  it('downloads every symbol-month of the universe and exits 0', async () => {
    deliver([archiveRow(0)]);
    const universe = join(dir, 'u.json');
    writeFileSync(universe, JSON.stringify({ markets: [{ binanceSymbol: 'ETHUSDT' }, { binanceSymbol: null }, { binanceSymbol: 'BTCUSDT' }] }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await main(['--universe', universe, '--out-dir', join(dir, 'out'), '--from-month', '2026-09', '--to-month', '2026-10']);
    expect(code).toBe(0);
    expect(callsOf('monthly')).toHaveLength(4);
    const summary = JSON.parse(String(log.mock.calls[0][0]));
    expect(summary).toMatchObject({ written: 4, skipped: 0, missing: 0, errors: 0 });
    log.mockRestore();
    err.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Gap repair from daily files
// ---------------------------------------------------------------------------

const FEB = Date.UTC(2025, 1, 1);
const DAY = 86_400_000;
const FEB_MINUTES = 28 * 1440;
const feb10 = FEB + 9 * DAY;

function rowAt(t: number, tag = '1'): string {
  return `${t},100.${tag},101.${tag},99.${tag},100.5,12.5,${t + 59_999},1250.75,42,6.25,625.5,0`;
}

/** Monthly rows for February 2025 from minute `from`, leaving out minutes for which `skip` is true. */
function febRows(skip: (minute: number) => boolean = () => false, from = 0): string[] {
  const out: string[] = [];
  for (let m = from; m < FEB_MINUTES; m++) if (!skip(m)) out.push(rowAt(FEB + m * 60_000));
  return out;
}

function dayRows(dayStart: number, count = 1440, tagAt: (minute: number) => string = () => '1'): string[] {
  const out: string[] = [];
  for (let m = 0; m < count; m++) out.push(rowAt(dayStart + m * 60_000, tagAt(m)));
  return out;
}

const inFeb10 = (m: number): boolean => m >= 9 * 1440 && m < 10 * 1440;
const febJob = { symbol: 'ETHUSDT', month: '2025-02' };

function lastManifest(): ManifestEntryLike {
  const lines = readFileSync(join(dir, 'manifest.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]) as ManifestEntryLike;
}
type ManifestEntryLike = Record<string, unknown> & { gaps: number; gapRanges: [number, number][]; repairedDays: string[]; dailyMissing: string[]; conflicts: number; rows: number };

function readOutputTimes(job: { symbol: string; month: string }): number[] {
  const text = gunzipSync(readFileSync(outputPath(dir, job))).toString('utf8');
  return text.trim().split('\n').slice(1).map((line) => Number(line.split(',')[0]));
}

describe('gap repair from daily files', () => {
  it('fills a month that lacks one whole day from the daily file, sorted, with gaps 0', async () => {
    deliver(febRows(inFeb10), { '2025-02-10': dayRows(feb10) });
    expect(await processFile(febJob, dir, { force: false, manifest: new Map() })).toBe('written');

    const entry = lastManifest();
    expect(entry).toMatchObject({ rows: FEB_MINUTES, gaps: 0, gapRanges: [], repairedDays: ['2025-02-10'], dailyMissing: [], conflicts: 0 });

    const times = readOutputTimes(febJob);
    expect(times).toHaveLength(FEB_MINUTES);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[9 * 1440]).toBe(feb10);

    expect(callsOf('daily')).toEqual([{ dataset: 'klines', symbol: 'ETHUSDT', interval: '1m', date: '2025-02-10', cadence: 'daily' }]);
  });

  it('keeps a day the daily file does not have as a recorded gap', async () => {
    deliver(febRows(inFeb10), { '2025-02-10': 'missing' });
    await processFile(febJob, dir, { force: false, manifest: new Map() });

    expect(lastManifest()).toMatchObject({
      rows: FEB_MINUTES - 1440,
      gaps: 1440,
      gapRanges: [[feb10, feb10 + DAY - 60_000]],
      repairedDays: [],
      dailyMissing: ['2025-02-10'],
      conflicts: 0,
    });
  });

  it('counts a partly filled day as repaired and leaves the rest as a gap range', async () => {
    deliver(febRows(inFeb10), { '2025-02-10': dayRows(feb10, 600) });
    await processFile(febJob, dir, { force: false, manifest: new Map() });

    expect(lastManifest()).toMatchObject({
      rows: FEB_MINUTES - 840,
      gaps: 840,
      gapRanges: [[feb10 + 600 * 60_000, feb10 + DAY - 60_000]],
      repairedDays: ['2025-02-10'],
      dailyMissing: [],
    });
  });

  it('keeps the monthly row and counts a conflict when the daily row differs', async () => {
    const lacksStart = (m: number): boolean => m >= 9 * 1440 && m < 9 * 1440 + 100;
    const conflictMinute = 100;
    deliver(febRows(lacksStart), {
      '2025-02-10': dayRows(feb10, 1440, (m) => (m === conflictMinute ? '2' : '1')),
    });
    await processFile(febJob, dir, { force: false, manifest: new Map() });

    expect(lastManifest()).toMatchObject({ rows: FEB_MINUTES, gaps: 0, repairedDays: ['2025-02-10'], conflicts: 1 });
    const text = gunzipSync(readFileSync(outputPath(dir, febJob))).toString('utf8');
    const t = feb10 + conflictMinute * 60_000;
    expect(text).toContain(`\n${t},100.1,101.1,`);
    expect(text).not.toContain(`\n${t},100.2,`);
  });

  it('does not count identical overlapping rows as conflicts or as repairs', async () => {
    deliver(febRows(), { '2025-02-10': dayRows(feb10) });
    await processFile(febJob, dir, { force: false, manifest: new Map() });
    expect(callsOf('daily')).toHaveLength(0);
    expect(lastManifest()).toMatchObject({ gaps: 0, repairedDays: [], conflicts: 0 });

    // A deficient day whose daily rows already exist in the month adds nothing.
    const result = await repairFromDaily(
      febJob,
      new Map(febRows((m) => m === 9 * 1440 + 5).map((line) => [Number(line.split(',')[0]), [line.split(',')[0]]] as [number, string[]])),
      async () => false,
      async () => []
    );
    expect(result).toMatchObject({ repairedDays: [], dailyMissing: [], conflicts: 0 });
  });

  it('ignores daily rows that fall outside the requested day', async () => {
    deliver(febRows(inFeb10), { '2025-02-10': [...dayRows(feb10, 10), rowAt(feb10 + DAY), rowAt(feb10 - 60_000)] });
    await processFile(febJob, dir, { force: false, manifest: new Map() });
    expect(lastManifest()).toMatchObject({ rows: FEB_MINUTES - 1440 + 10, gaps: 1430 });
  });

  it('first-month rule: in the listing month only days from the first present minute are tried', async () => {
    const start = 4 * 1440 + 720; // 2025-02-05 12:00
    const probe = vi.fn(async () => true);
    deliver(febRows((m) => m >= 19 * 1440 && m < 20 * 1440, start), {});
    await processFile(febJob, dir, { force: false, manifest: new Map(), probe });

    expect(probe).toHaveBeenCalledWith('ETHUSDT', '2025-02');
    expect(callsOf('daily').map((s) => s.date)).toEqual(['2025-02-20']);
    expect(lastManifest()).toMatchObject({ dailyMissing: ['2025-02-20'], gaps: 1440 });
  });

  it('without the listing finding, leading days are tried like any other deficient day', async () => {
    const start = 4 * 1440 + 720;
    deliver(febRows(() => false, start), {});
    await processFile(febJob, dir, { force: false, manifest: new Map(), probe: async () => false });
    expect(callsOf('daily').map((s) => s.date)).toEqual(['2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04', '2025-02-05']);
  });

  it('decides the listing month by a 404 on the previous month file, and a month with full days needs no probe', async () => {
    const start = 4 * 1440 + 720;
    mockStream.mockImplementation(async (spec: ArchiveSpec, onLine: (line: string) => void) => {
      if (spec.cadence === 'monthly' && spec.date === '2025-01') return { status: 'missing' };
      if (spec.cadence === 'daily') return { status: 'missing' };
      for (const line of febRows(() => false, start)) onLine(line);
      return { status: 'ok', lines: 0, uncompressedBytes: 0 };
    });
    await processFile(febJob, dir, { force: false, manifest: new Map() });

    expect(callsOf('monthly').map((s) => s.date)).toEqual(['2025-02', '2025-01']);
    expect(mockStream.mock.calls[1][0]).toEqual({ dataset: 'klines', symbol: 'ETHUSDT', interval: '1m', date: '2025-01', cadence: 'monthly' });
    expect(callsOf('daily')).toHaveLength(0);
    expect(lastManifest()).toMatchObject({ gaps: 0, dailyMissing: [] });

    mockStream.mockClear();
    deliver(febRows(), {});
    await processFile({ symbol: 'BTCUSDT', month: '2025-02' }, dir, { force: false, manifest: new Map() });
    expect(callsOf('monthly')).toHaveLength(1);
  });

  it('does not try days of a missing monthly file', async () => {
    deliver('missing', { '2025-02-10': dayRows(feb10) });
    expect(await processFile(febJob, dir, { force: false, manifest: new Map() })).toBe('missing');
    expect(callsOf('daily')).toHaveLength(0);
    expect(existsSync(outputPath(dir, febJob))).toBe(false);
  });

  it('applies the month guard to days', async () => {
    expect(() => assertDayAllowed('2026-10-31')).not.toThrow();
    expect(() => assertDayAllowed('2026-11-01')).toThrow(/reserved forward sample/);
    expect(() => assertDayAllowed('2027-01-15')).toThrow(/reserved forward sample/);
    expect(() => assertDayAllowed('2026-10')).toThrow(/YYYY-MM-DD/);
    await expect(fetchDailyLines('ETHUSDT', '2026-11-01')).rejects.toThrow(/reserved forward sample/);
    await expect(fetchDailyLines('../ETHUSDT', '2026-10-01')).rejects.toThrow(/not a USDT-M/);
    expect(mockStream).not.toHaveBeenCalled();

    // A repair that is handed a day outside the guard stops before the download.
    const fetchDay = vi.fn(async () => []);
    await expect(
      repairFromDaily({ symbol: 'ETHUSDT', month: '2026-11' }, new Map([[Date.UTC(2026, 10, 1), ['x']]]), async () => false, fetchDay)
    ).rejects.toThrow(/reserved forward sample/);
    expect(fetchDay).not.toHaveBeenCalled();
  });

  it('builds the daily spec the client expects', async () => {
    deliver(['x'], { '2026-10-28': dayRows(Date.UTC(2026, 9, 28), 3) });
    const lines = await fetchDailyLines('BTCUSDT', '2026-10-28');
    expect(lines).toHaveLength(3);
    expect(mockStream.mock.calls[0][0]).toEqual({ dataset: 'klines', symbol: 'BTCUSDT', interval: '1m', date: '2026-10-28', cadence: 'daily' });
    deliver(['x'], {});
    expect(await fetchDailyLines('BTCUSDT', '2026-10-29')).toBeNull();
  });
});

describe('deficientDays', () => {
  const minute = (day: number, m: number): number => FEB + (day - 1) * DAY + m * 60_000;

  it('lists days with fewer than 1,440 minutes and ignores complete ones', () => {
    const times = febRows((m) => m === 3 * 1440 + 7).map((line) => Number(line.split(',')[0]));
    expect(deficientDays(times, '2025-02', null)).toEqual(['2025-02-04']);
  });

  it('lists every day of an empty month, 28 for February 2025 and 31 for December', () => {
    expect(deficientDays([], '2025-02', null)).toHaveLength(28);
    expect(deficientDays([], '2025-12', null)).toHaveLength(31);
  });

  it('expects only minutes from the first present one in the listing month', () => {
    const first = minute(5, 720);
    const times = febRows(() => false, 4 * 1440 + 720).map((line) => Number(line.split(',')[0]));
    expect(deficientDays(times, '2025-02', first)).toEqual([]);
    expect(deficientDays(times.slice(1), '2025-02', first)).toEqual(['2025-02-05']);
    expect(deficientDays(times, '2025-02', null)).toEqual(['2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04', '2025-02-05']);
  });
});

describe('findGapRanges', () => {
  it('returns first and last missing minute of each hole and caps the list', () => {
    expect(findGapRanges([T0, T0 + 60_000, T0 + 240_000, T0 + 300_000, T0 + 420_000])).toEqual([
      [T0 + 120_000, T0 + 180_000],
      [T0 + 360_000, T0 + 360_000],
    ]);
    const sparse = Array.from({ length: 80 }, (_, i) => T0 + i * 120_000);
    expect(findGapRanges(sparse)).toHaveLength(50);
    expect(findGapRanges([])).toEqual([]);
  });
});

describe('redo rule for files from before gap repair', () => {
  const job = { symbol: 'ETHUSDT', month: '2025-02' };

  /** Writes a file the way the old version did: sorted rows with a one-minute hole, no repair fields. */
  function writeOldFile(): void {
    const rows = febRows((m) => m === 100).map((line) => line.split(',').slice(0, 1).concat(['1', '2', '3', '4', '5', '6', '7', '8', '9']).join(','));
    mkdirSync(join(dir, 'ETHUSDT'), { recursive: true });
    writeFileSync(outputPath(dir, job), gzipSync(Buffer.from(`${OUTPUT_HEADER}\n${rows.join('\n')}\n`)));
  }

  it('needsRedo is true only for gaps without a repairedDays field', () => {
    expect(needsRedo({ gaps: 1440 })).toBe(true);
    expect(needsRedo({ gaps: 1440, repairedDays: [] })).toBe(false);
    expect(needsRedo({ gaps: 0 })).toBe(false);
    expect(needsRedo({})).toBe(false);
  });

  it('redoes a file whose manifest line shows gaps and has no repairedDays', async () => {
    writeOldFile();
    deliver(febRows(), {});
    const manifest = new Map<string, StoredManifestEntry>([['ETHUSDT|2025-02', { symbol: 'ETHUSDT', month: '2025-02', gaps: 1 }]]);
    expect(await processFile(job, dir, { force: false, manifest })).toBe('written');
    expect(callsOf('monthly')).toHaveLength(1);
    expect(lastManifest()).toMatchObject({ gaps: 0, rows: FEB_MINUTES });
    expect(manifest.get('ETHUSDT|2025-02')?.repairedDays).toEqual([]);
  });

  it('skips a file whose manifest line already has repairedDays, even with gaps left', async () => {
    writeOldFile();
    deliver(febRows(), {});
    const manifest = new Map<string, StoredManifestEntry>([
      ['ETHUSDT|2025-02', { symbol: 'ETHUSDT', month: '2025-02', gaps: 1, repairedDays: [], dailyMissing: ['2025-02-01'] }],
    ]);
    expect(await processFile(job, dir, { force: false, manifest })).toBe('skipped');
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('skips a file with no gaps and no repairedDays field', async () => {
    writeOldFile();
    deliver(febRows(), {});
    const manifest = new Map<string, StoredManifestEntry>([['ETHUSDT|2025-02', { symbol: 'ETHUSDT', month: '2025-02', gaps: 0 }]]);
    expect(await processFile(job, dir, { force: false, manifest })).toBe('skipped');
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('redoes an existing file with gaps and no manifest line at all', async () => {
    writeOldFile();
    deliver(febRows(), {});
    expect(await processFile(job, dir, { force: false, manifest: new Map() })).toBe('written');
    expect(lastManifest()).toMatchObject({ gaps: 0 });
  });

  it('--force always redoes', async () => {
    writeOldFile();
    deliver(febRows(), {});
    const manifest = new Map<string, StoredManifestEntry>([['ETHUSDT|2025-02', { symbol: 'ETHUSDT', month: '2025-02', gaps: 0, repairedDays: [] }]]);
    expect(await processFile(job, dir, { force: true, manifest })).toBe('written');
  });
});
