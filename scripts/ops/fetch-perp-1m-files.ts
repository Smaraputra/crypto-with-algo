/**
 * Downloads Binance USDT-M perpetual 1-minute klines to gzip CSV files for an offline (Python) study.
 *
 * Why this exists: the Lighter study needs 1m bars for every market in the cost-only universe file
 * (`scripts/research/lighter-universe.ts`) that has a Binance symbol. Production MongoDB must not be
 * touched, so this script imports no Mongoose model and opens no database connection. It uses only the
 * archive client in `src/lib/external/binance-archive.ts` (URL building, the streamed download with
 * crc32 and size verification of the zip entry, retry with backoff) and writes plain files.
 *
 * RESERVED FORWARD SAMPLE. Months after 2026-10 are refused with no override (`MAX_MONTH`): later data
 * is a reserved forward sample. The guard runs in argument parsing and again before every download.
 *
 * Output, per symbol and month:
 *   <out-dir>/<SYMBOL>/<SYMBOL>-1m-YYYY-MM.csv.gz
 * with the header
 *   open_time,open,high,low,close,volume,quote_volume,trades,taker_buy_base,taker_buy_quote
 * and one row per minute. The columns are the archive's own text values (close_time and the trailing
 * ignore column are dropped); open_time is epoch milliseconds. An archive file may or may not carry its
 * own header row, and both are handled (`looksLikeHeader`).
 *
 * Files are written to a temp name and renamed. A file that exists with a non-zero size is skipped
 * unless --force, so a run resumes cleanly. The output files are the cache: this path does not use the
 * archive client's zip cache, because the streaming call that verifies the zip's crc32 has none.
 *
 * GAP REPAIR FROM DAILY FILES. The monthly archive file can silently omit whole days (BTCUSDT 2026-10
 * lacks 2026-10-28 while the daily file exists). After a month is collected, every UTC day with fewer
 * minutes than it should have is fetched from the DAILY klines file (same client, `cadence: 'daily'`) and
 * merged in: rows are deduped by open_time, a monthly row wins a clash (a clash with different values is
 * counted in `conflicts`), and the rows are re-sorted. A day whose daily file is a 404 stays a gap and is
 * listed in `dailyMissing`. In the symbol's listing month (the previous month's monthly file is a 404)
 * only minutes from the first present one onward are expected. A month whose monthly file is a 404 is
 * "missing" and its days are not tried. The month guard applies to days too.
 *
 * <out-dir>/manifest.jsonl gets one line per written file: symbol, month, rows, firstOpenTime,
 * lastOpenTime, sha256 of the written file, gaps (missing minutes between first and last, AFTER repair),
 * gapRanges (up to 50 [firstMissingOpenTime, lastMissingOpenTime] pairs left after repair), repairedDays,
 * dailyMissing, conflicts, badRows, duplicates. A skipped file with no manifest line gets one, computed
 * from the file on disk. A file whose manifest line shows gaps > 0 and has no `repairedDays` field was
 * written before gap repair existed and is redone, not skipped. With --force a month can appear twice:
 * the last line for a symbol and month wins.
 *
 * A 404 (the symbol was listed after the month) is recorded as "missing" in the summary, not as an error.
 *
 * RESULT: not run against the network (Binance is blocked from the development machine).
 *
 * Usage:
 *   npx tsx scripts/ops/fetch-perp-1m-files.ts --universe <json> --out-dir <dir> [--from-month 2025-01] [--to-month 2026-10] [--concurrency 4] [--force]
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { looksLikeHeader, parseArchiveTimestamp, streamArchiveCsvLines } from '@/lib/external/binance-archive';

/** Last month this script will fetch. Anything later is a reserved forward sample. */
export const MAX_MONTH = '2026-10';
export const DEFAULT_FROM_MONTH = '2025-01';
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 8;
export const MINUTE_MS = 60_000;

export const OUTPUT_HEADER = 'open_time,open,high,low,close,volume,quote_volume,trades,taker_buy_base,taker_buy_quote';

/** Archive column indices for the output columns: open_time, OHLC, volume, quote_volume, count, taker buy base, taker buy quote. */
const SOURCE_COLUMNS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10] as const;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}USDT$/;

export interface FetchArgs {
  universe: string;
  outDir: string;
  fromMonth: string;
  toMonth: string;
  concurrency: number;
  force: boolean;
}

export interface FileJob {
  symbol: string;
  month: string;
}

export interface ShapedKlines {
  csv: string;
  rows: number;
  firstOpenTime: number | null;
  lastOpenTime: number | null;
  gaps: number;
  /** Up to MAX_GAP_RANGES [firstMissingOpenTime, lastMissingOpenTime] pairs between first and last. */
  gapRanges: [number, number][];
  badRows: number;
  duplicates: number;
  /** Days (YYYY-MM-DD) a daily file filled, fully or partly. */
  repairedDays: string[];
  /** Days (YYYY-MM-DD) whose daily file was a 404. */
  dailyMissing: string[];
  /** Rows present in both monthly and daily files with different values (the monthly row is kept). */
  conflicts: number;
}

export interface ManifestEntry {
  symbol: string;
  month: string;
  rows: number;
  firstOpenTime: number | null;
  lastOpenTime: number | null;
  sha256: string;
  gaps: number;
  gapRanges: [number, number][];
  repairedDays: string[];
  dailyMissing: string[];
  conflicts: number;
  badRows: number;
  duplicates: number;
}

/** A manifest line as read back from disk: older versions lack the repair fields. */
export type StoredManifestEntry = Partial<ManifestEntry>;

export type FileOutcome = 'written' | 'skipped' | 'missing';

export interface Summary {
  written: number;
  skipped: number;
  missing: number;
  errors: number;
  missingFiles: string[];
  errorFiles: { file: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Months and guard
// ---------------------------------------------------------------------------

export function assertMonthAllowed(month: string): void {
  if (!MONTH_PATTERN.test(month)) throw new Error(`month must be YYYY-MM, got "${month}"`);
  if (month > MAX_MONTH) {
    throw new Error(`month ${month} is after ${MAX_MONTH}: later data is a reserved forward sample and is never fetched`);
  }
}

/** Inclusive list of YYYY-MM months. Both ends must pass the guard. */
export function enumerateMonthKeys(fromMonth: string, toMonth: string): string[] {
  assertMonthAllowed(fromMonth);
  assertMonthAllowed(toMonth);
  if (fromMonth > toMonth) throw new Error(`--from-month ${fromMonth} is after --to-month ${toMonth}`);
  const out: string[] = [];
  let year = Number(fromMonth.slice(0, 4));
  let month = Number(fromMonth.slice(5, 7));
  const lastYear = Number(toMonth.slice(0, 4));
  const lastMonth = Number(toMonth.slice(5, 7));
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Universe file
// ---------------------------------------------------------------------------

/** The sorted, unique Binance symbols of the universe file's markets, skipping markets without one. */
export function symbolsFromUniverse(json: unknown): string[] {
  const rec = typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  if (!rec || !Array.isArray(rec.markets)) throw new Error('universe file has no markets array');
  const symbols = new Set<string>();
  for (const market of rec.markets) {
    if (typeof market !== 'object' || market === null) continue;
    const symbol = (market as Record<string, unknown>).binanceSymbol;
    if (symbol === null || symbol === undefined) continue;
    // The symbol ends up in a URL and in file paths, so only the contract shape is accepted.
    if (typeof symbol !== 'string' || !SYMBOL_PATTERN.test(symbol)) {
      throw new Error(`universe binanceSymbol "${String(symbol)}" is not a USDT-M contract symbol`);
    }
    symbols.add(symbol);
  }
  return [...symbols].sort();
}

export function buildJobs(symbols: readonly string[], months: readonly string[]): FileJob[] {
  const jobs: FileJob[] = [];
  for (const symbol of symbols) for (const month of months) jobs.push({ symbol, month });
  return jobs;
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/** Missing minutes between the first and last open_time, given the distinct open times. */
export function countGaps(openTimes: readonly number[]): number {
  if (openTimes.length < 2) return 0;
  let first = Infinity;
  let last = -Infinity;
  for (const t of openTimes) {
    if (t < first) first = t;
    if (t > last) last = t;
  }
  const expected = Math.round((last - first) / MINUTE_MS) + 1;
  return Math.max(0, expected - openTimes.length);
}

export const MAX_GAP_RANGES = 50;
export const DAY_MINUTES = 1440;
const DAY_MS = DAY_MINUTES * MINUTE_MS;

/** Rows of one archive file: open_time to the ten output columns (open_time first, as text). */
export interface ParsedKlines {
  rows: Map<number, string[]>;
  badRows: number;
  duplicates: number;
}

/**
 * Parses archive kline lines (header or not) into output rows keyed by open_time.
 * A row with fewer than 11 fields or no usable open_time counts as bad and is dropped. A repeated
 * open_time keeps its first row and counts as a duplicate.
 */
export function parseKlineLines(lines: readonly string[]): ParsedKlines {
  const rows = new Map<number, string[]>();
  let badRows = 0;
  let duplicates = 0;
  let first = true;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (first) {
      first = false;
      if (looksLikeHeader(line)) continue;
    }
    const fields = line.split(',');
    const openTime = parseArchiveTimestamp(fields[0] ?? '');
    if (fields.length < 11 || !Number.isFinite(openTime)) {
      badRows++;
      continue;
    }
    if (rows.has(openTime)) {
      duplicates++;
      continue;
    }
    rows.set(openTime, [String(openTime), ...SOURCE_COLUMNS.slice(1).map((i) => fields[i].trim())]);
  }
  return { rows, badRows, duplicates };
}

/** Runs of missing minutes between the first and last of the sorted, distinct open times, capped. */
export function findGapRanges(sortedTimes: readonly number[], cap: number = MAX_GAP_RANGES): [number, number][] {
  const ranges: [number, number][] = [];
  for (let i = 1; i < sortedTimes.length && ranges.length < cap; i++) {
    const step = Math.round((sortedTimes[i] - sortedTimes[i - 1]) / MINUTE_MS);
    if (step > 1) ranges.push([sortedTimes[i - 1] + MINUTE_MS, sortedTimes[i] - MINUTE_MS]);
  }
  return ranges;
}

export interface ShapeExtras {
  badRows?: number;
  duplicates?: number;
  repairedDays?: string[];
  dailyMissing?: string[];
  conflicts?: number;
}

/** Sorts rows by open_time and builds the output CSV and statistics. */
export function shapeRows(rows: ReadonlyMap<number, string[]>, extras: ShapeExtras = {}): ShapedKlines {
  const times = [...rows.keys()].sort((a, b) => a - b);
  const out: string[] = [OUTPUT_HEADER];
  for (const t of times) out.push(rows.get(t)!.join(','));
  return {
    csv: out.join('\n') + '\n',
    ...openTimeStats(times),
    gapRanges: findGapRanges(times),
    badRows: extras.badRows ?? 0,
    duplicates: extras.duplicates ?? 0,
    repairedDays: extras.repairedDays ?? [],
    dailyMissing: extras.dailyMissing ?? [],
    conflicts: extras.conflicts ?? 0,
  };
}

/** Shapes archive kline lines (header or not), without any repair. */
export function shapeKlineLines(lines: readonly string[]): ShapedKlines {
  const parsed = parseKlineLines(lines);
  return shapeRows(parsed.rows, { badRows: parsed.badRows, duplicates: parsed.duplicates });
}

function openTimeStats(sortedTimes: readonly number[]): Pick<ShapedKlines, 'rows' | 'firstOpenTime' | 'lastOpenTime' | 'gaps'> {
  return {
    rows: sortedTimes.length,
    firstOpenTime: sortedTimes.length > 0 ? sortedTimes[0] : null,
    lastOpenTime: sortedTimes.length > 0 ? sortedTimes[sortedTimes.length - 1] : null,
    gaps: countGaps(sortedTimes),
  };
}

/**
 * Statistics of a file this script wrote (the ten-column output, header first). Used to add the
 * manifest line of a skipped file that has none. `csv` is returned as given, and the repair fields are
 * empty because the file does not record them.
 */
export function summariseOutputCsv(csv: string): ShapedKlines {
  const seen = new Set<number>();
  let badRows = 0;
  let duplicates = 0;
  let first = true;
  for (const raw of csv.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (first) {
      first = false;
      if (line === OUTPUT_HEADER) continue;
    }
    const fields = line.split(',');
    const openTime = parseArchiveTimestamp(fields[0] ?? '');
    if (fields.length !== SOURCE_COLUMNS.length || !Number.isFinite(openTime)) {
      badRows++;
      continue;
    }
    if (seen.has(openTime)) duplicates++;
    else seen.add(openTime);
  }
  const times = [...seen].sort((a, b) => a - b);
  return {
    csv,
    ...openTimeStats(times),
    gapRanges: findGapRanges(times),
    badRows,
    duplicates,
    repairedDays: [],
    dailyMissing: [],
    conflicts: 0,
  };
}

// ---------------------------------------------------------------------------
// Daily repair
// ---------------------------------------------------------------------------

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Same guard as months, applied to a UTC day (YYYY-MM-DD): nothing after the last allowed month. */
export function assertDayAllowed(day: string): void {
  if (!DAY_PATTERN.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))) {
    throw new Error(`day must be YYYY-MM-DD, got "${day}"`);
  }
  assertMonthAllowed(day.slice(0, 7));
}

export function previousMonth(month: string): string {
  assertMonthAllowed(month);
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, '0')}`;
}

export function monthStartMs(month: string): number {
  return Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
}

/**
 * UTC days of `month` that have fewer minutes than expected. A day is expected to hold every minute
 * from `firstExpectedMs` (or its own start, if later) to its end. Pass the first present minute as
 * `firstExpectedMs` for a symbol's listing month, else null. Days wholly before it are ignored.
 */
export function deficientDays(openTimes: readonly number[], month: string, firstExpectedMs: number | null): string[] {
  const start = monthStartMs(month);
  const nextStart = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);
  const dayCount = Math.round((nextStart - start) / DAY_MS);
  const present = new Array<number>(dayCount).fill(0);
  for (const t of openTimes) {
    if (t >= start && t < nextStart) present[Math.floor((t - start) / DAY_MS)]++;
  }
  const days: string[] = [];
  for (let d = 0; d < dayCount; d++) {
    const dayStart = start + d * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const expectedFrom = firstExpectedMs === null ? dayStart : Math.max(dayStart, firstExpectedMs);
    if (expectedFrom >= dayEnd) continue;
    if (present[d] < Math.ceil((dayEnd - expectedFrom) / MINUTE_MS)) {
      days.push(new Date(dayStart).toISOString().slice(0, 10));
    }
  }
  return days;
}

/**
 * The lines of one DAILY klines file, or null on a 404. The daily spec handed to the archive client is
 * { dataset: 'klines', symbol, interval: '1m', date: 'YYYY-MM-DD', cadence: 'daily' }.
 */
export async function fetchDailyLines(symbol: string, day: string): Promise<string[] | null> {
  assertDayAllowed(day);
  if (!SYMBOL_PATTERN.test(symbol)) throw new Error(`"${symbol}" is not a USDT-M contract symbol`);
  let lines: string[] = [];
  const result = await streamArchiveCsvLines(
    { dataset: 'klines', symbol, interval: '1m', date: day, cadence: 'daily' },
    (line) => {
      lines.push(line);
    },
    { onRestart: () => (lines = []) }
  );
  return result.status === 'missing' ? null : lines;
}

/** Whether `month` is the symbol's listing month: the previous month's monthly file is a 404. */
export async function isListingMonth(symbol: string, month: string): Promise<boolean> {
  const result = await streamArchiveCsvLines(
    { dataset: 'klines', symbol, interval: '1m', date: previousMonth(month), cadence: 'monthly' },
    () => undefined,
    { onRestart: () => undefined }
  );
  return result.status === 'missing';
}

export interface RepairResult {
  repairedDays: string[];
  dailyMissing: string[];
  conflicts: number;
  badRows: number;
}

/**
 * Fills the deficient days of a month from the daily files, mutating `rows`. A monthly row wins a
 * clash; a clash with different values counts as a conflict. A day that gained at least one row is
 * repaired; a 404 day is dailyMissing and stays a gap.
 */
export async function repairFromDaily(
  job: FileJob,
  rows: Map<number, string[]>,
  probe: (symbol: string, month: string) => Promise<boolean> = isListingMonth,
  fetchDay: (symbol: string, day: string) => Promise<string[] | null> = fetchDailyLines
): Promise<RepairResult> {
  const result: RepairResult = { repairedDays: [], dailyMissing: [], conflicts: 0, badRows: 0 };
  const times = [...rows.keys()];
  if (times.length === 0) return result;

  const monthStart = monthStartMs(job.month);
  let firstPresent = Infinity;
  for (const t of times) if (t < firstPresent) firstPresent = t;
  const firstExpected = firstPresent > monthStart && (await probe(job.symbol, job.month)) ? firstPresent : null;

  for (const day of deficientDays(times, job.month, firstExpected)) {
    assertDayAllowed(day);
    const lines = await fetchDay(job.symbol, day);
    if (lines === null) {
      result.dailyMissing.push(day);
      continue;
    }
    const parsed = parseKlineLines(lines);
    result.badRows += parsed.badRows;
    const dayStart = Date.parse(`${day}T00:00:00Z`);
    let added = 0;
    for (const [openTime, row] of parsed.rows) {
      if (openTime < dayStart || openTime >= dayStart + DAY_MS) continue;
      const existing = rows.get(openTime);
      if (existing === undefined) {
        rows.set(openTime, row);
        added++;
      } else if (existing.join(',') !== row.join(',')) {
        result.conflicts++;
      }
    }
    if (added > 0) result.repairedDays.push(day);
  }
  return result;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function manifestEntry(job: FileJob, shaped: ShapedKlines, fileSha256: string): ManifestEntry {
  return {
    symbol: job.symbol,
    month: job.month,
    rows: shaped.rows,
    firstOpenTime: shaped.firstOpenTime,
    lastOpenTime: shaped.lastOpenTime,
    sha256: fileSha256,
    gaps: shaped.gaps,
    gapRanges: shaped.gapRanges,
    repairedDays: shaped.repairedDays,
    dailyMissing: shaped.dailyMissing,
    conflicts: shaped.conflicts,
    badRows: shaped.badRows,
    duplicates: shaped.duplicates,
  };
}

export function manifestLine(entry: ManifestEntry): string {
  return JSON.stringify(entry);
}

export function outputPath(outDir: string, job: FileJob): string {
  return join(outDir, job.symbol, `${job.symbol}-1m-${job.month}.csv.gz`);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Manifest entries by "SYMBOL|YYYY-MM", the last line winning. A missing manifest is empty. */
export function readManifest(manifestPath: string): Map<string, StoredManifestEntry> {
  const entries = new Map<string, StoredManifestEntry>();
  if (!existsSync(manifestPath)) return entries;
  for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const rec = JSON.parse(line) as StoredManifestEntry;
      if (typeof rec.symbol === 'string' && typeof rec.month === 'string') entries.set(`${rec.symbol}|${rec.month}`, rec);
    } catch {
      // A torn last line is ignored: the file it described is re-summarised below.
    }
  }
  return entries;
}

/** A manifest line from before gap repair: it shows gaps and has no `repairedDays` field. */
export function needsRedo(entry: StoredManifestEntry): boolean {
  return typeof entry.gaps === 'number' && entry.gaps > 0 && !Array.isArray(entry.repairedDays);
}

function hasContent(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ProcessOptions {
  force: boolean;
  manifest: Map<string, StoredManifestEntry>;
  /** Test seams; the defaults call the archive client. */
  probe?: (symbol: string, month: string) => Promise<boolean>;
  fetchDay?: (symbol: string, day: string) => Promise<string[] | null>;
}

/**
 * Handles one symbol-month. Skips an existing non-empty file (adding its manifest line when it has
 * none), unless its manifest shows gaps from before gap repair existed. Reports a 404 monthly file as
 * missing. Otherwise streams the monthly file, repairs deficient days from the daily files, shapes the
 * rows, writes them to a temp name, renames it and appends the manifest line.
 */
export async function processFile(job: FileJob, outDir: string, options: ProcessOptions): Promise<FileOutcome> {
  assertMonthAllowed(job.month);
  if (!SYMBOL_PATTERN.test(job.symbol)) throw new Error(`"${job.symbol}" is not a USDT-M contract symbol`);

  const finalPath = outputPath(outDir, job);
  const manifestPath = join(outDir, 'manifest.jsonl');
  const key = `${job.symbol}|${job.month}`;

  if (!options.force && hasContent(finalPath)) {
    const existing = options.manifest.get(key);
    if (existing !== undefined) {
      if (!needsRedo(existing)) return 'skipped';
    } else {
      const bytes = readFileSync(finalPath);
      const shaped = summariseOutputCsv(gunzipSync(bytes).toString('utf8'));
      if (shaped.gaps === 0) {
        const entry = manifestEntry(job, shaped, sha256Hex(bytes));
        appendFileSync(manifestPath, manifestLine(entry) + '\n');
        options.manifest.set(key, entry);
        return 'skipped';
      }
      // Gaps with no record of a repair attempt: redo.
    }
  }

  let lines: string[] = [];
  const result = await streamArchiveCsvLines(
    { dataset: 'klines', symbol: job.symbol, interval: '1m', date: job.month, cadence: 'monthly' },
    (line) => {
      lines.push(line);
    },
    { onRestart: () => (lines = []) }
  );
  if (result.status === 'missing') return 'missing';

  const parsed = parseKlineLines(lines);
  if (parsed.rows.size === 0) throw new Error(`${job.symbol} ${job.month}: archive file held no usable rows`);

  const repair = await repairFromDaily(job, parsed.rows, options.probe, options.fetchDay);
  const shaped = shapeRows(parsed.rows, {
    badRows: parsed.badRows + repair.badRows,
    duplicates: parsed.duplicates,
    repairedDays: repair.repairedDays,
    dailyMissing: repair.dailyMissing,
    conflicts: repair.conflicts,
  });

  const bytes = gzipSync(Buffer.from(shaped.csv, 'utf8'));
  mkdirSync(join(outDir, job.symbol), { recursive: true });
  const tempPath = `${finalPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, bytes);
    renameSync(tempPath, finalPath);
  } catch (error) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }

  const entry = manifestEntry(job, shaped, sha256Hex(bytes));
  appendFileSync(manifestPath, manifestLine(entry) + '\n');
  options.manifest.set(key, entry);
  return 'written';
}

async function forEachWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** Runs all jobs with bounded concurrency and tallies the outcomes. Never throws for a single file. */
export async function runJobs(
  jobs: readonly FileJob[],
  outDir: string,
  options: { force: boolean; concurrency: number }
): Promise<Summary> {
  mkdirSync(outDir, { recursive: true });
  const manifest = readManifest(join(outDir, 'manifest.jsonl'));
  const summary: Summary = { written: 0, skipped: 0, missing: 0, errors: 0, missingFiles: [], errorFiles: [] };

  await forEachWithConcurrency(jobs, options.concurrency, async (job) => {
    const label = `${job.symbol}-1m-${job.month}`;
    try {
      const outcome = await processFile(job, outDir, { force: options.force, manifest });
      if (outcome === 'written') summary.written++;
      else if (outcome === 'skipped') summary.skipped++;
      else {
        summary.missing++;
        summary.missingFiles.push(label);
      }
    } catch (error) {
      summary.errors++;
      summary.errorFiles.push({ file: label, error: errorMessage(error) });
    }
  });

  summary.missingFiles.sort();
  summary.errorFiles.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): FetchArgs {
  const flags = new Map<string, string>();
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}"`);
    const key = arg.slice(2);
    if (key === 'force') {
      force = true;
      continue;
    }
    if (!['universe', 'out-dir', 'from-month', 'to-month', 'concurrency'].includes(key)) {
      throw new Error(`Unknown flag "${arg}"`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for "${arg}"`);
    flags.set(key, value);
    i++;
  }

  for (const required of ['universe', 'out-dir']) {
    if (!flags.has(required)) throw new Error(`--${required} is required`);
  }

  const fromMonth = flags.get('from-month') ?? DEFAULT_FROM_MONTH;
  const toMonth = flags.get('to-month') ?? MAX_MONTH;
  assertMonthAllowed(fromMonth);
  assertMonthAllowed(toMonth);
  if (fromMonth > toMonth) throw new Error(`--from-month ${fromMonth} is after --to-month ${toMonth}`);

  let concurrency = DEFAULT_CONCURRENCY;
  if (flags.has('concurrency')) {
    const raw = flags.get('concurrency')!;
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_CONCURRENCY) {
      throw new Error(`--concurrency must be an integer from 1 to ${MAX_CONCURRENCY}, got "${raw}"`);
    }
    concurrency = Number(raw);
  }

  return { universe: flags.get('universe')!, outDir: flags.get('out-dir')!, fromMonth, toMonth, concurrency, force };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const symbols = symbolsFromUniverse(JSON.parse(readFileSync(args.universe, 'utf8')));
  if (symbols.length === 0) throw new Error('universe file has no market with a binanceSymbol');
  const months = enumerateMonthKeys(args.fromMonth, args.toMonth);
  const jobs = buildJobs(symbols, months);

  console.error(`fetch-perp-1m-files: ${symbols.length} symbols, ${months.length} months, ${jobs.length} files`);
  const summary = await runJobs(jobs, args.outDir, { force: args.force, concurrency: args.concurrency });
  console.log(JSON.stringify(summary, null, 2));
  return summary.errors > 0 ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
