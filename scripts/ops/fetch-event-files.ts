/**
 * Plan-driven Binance archive downloader for horizon-e1 event files.
 *
 * Fetches 1-minute klines and monthly funding rate files according to an input JSON plan,
 * writes gzip CSV files atomically, maintains an append-only manifest.jsonl, and enforces
 * date limits and format validation.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { looksLikeHeader, parseArchiveTimestamp, streamArchiveCsvLines } from '@/lib/external/binance-archive';
import {
  assertMonthAllowed,
  fetchDailyLines,
  parseKlineLines,
  sha256Hex,
  shapeRows,
} from './fetch-perp-1m-files';

export const HARD_LAST_DAY = '2026-11-12';
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 8;
export const FUNDING_OUTPUT_HEADER = 'calc_time,funding_interval_hours,last_funding_rate';

const DAY_MINUTES = 1440;
const MINUTE_MS = 60_000;
const DAY_MS = DAY_MINUTES * MINUTE_MS;

const SYMBOL_PATTERN = /^[A-Z0-9]{1,20}USDT$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface KlineJob {
  symbol: string;
  day: string;
}

export interface FundingJob {
  symbol: string;
  month: string;
}

export interface EventPlan {
  version: 1;
  klines: KlineJob[];
  funding: FundingJob[];
}

export interface EventFetchArgs {
  plan: string;
  outDir: string;
  concurrency: number;
  force: boolean;
}

export type FileOutcome = 'written' | 'skipped' | 'missing';

export interface EventManifestEntry {
  kind: 'klines' | 'funding';
  symbol: string;
  date: string;
  status: 'ok' | 'missing';
  rows: number;
  firstTs: number | null;
  lastTs: number | null;
  gaps: number | null;
  badRows: number;
  duplicates: number;
  sha256: string | null;
  bytes: number;
}

export interface Summary {
  written: number;
  skipped: number;
  missing: number;
  errors: number;
  missingFiles: string[];
  errorFiles: { file: string; error: string }[];
}

export interface ProcessOptions {
  force: boolean;
  manifest: Map<string, EventManifestEntry>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertDayValid(day: unknown): string {
  if (typeof day !== 'string' || !DAY_PATTERN.test(day)) {
    throw new Error(`day must be YYYY-MM-DD, got "${String(day)}"`);
  }
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new Error(`day must be a real calendar date, got "${day}"`);
  }
  if (day > HARD_LAST_DAY) {
    throw new Error(`day ${day} is after ${HARD_LAST_DAY}: later data is never fetched`);
  }
  try {
    assertMonthAllowed(day.slice(0, 7));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`day ${day}: ${msg}`);
  }
  return day;
}

function assertMonthValid(month: unknown): string {
  if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
    throw new Error(`month must be YYYY-MM, got "${String(month)}"`);
  }
  assertMonthAllowed(month);
  return month;
}

function assertSymbolValid(symbol: unknown): string {
  if (typeof symbol !== 'string' || !SYMBOL_PATTERN.test(symbol)) {
    throw new Error(`symbol "${String(symbol)}" is not a USDT-M contract symbol`);
  }
  return symbol;
}

/**
 * Validates and parses the plan JSON object.
 * Rejects unknown keys, invalid dates, symbols, or version != 1.
 * Drops duplicates and sorts jobs by kind, symbol, date.
 */
export function parsePlan(json: unknown): { klines: KlineJob[]; funding: FundingJob[] } {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Plan must be a JSON object');
  }

  const rec = json as Record<string, unknown>;
  const allowedTopKeys = new Set(['version', 'klines', 'funding']);
  for (const k of Object.keys(rec)) {
    if (!allowedTopKeys.has(k)) {
      throw new Error(`Unknown top-level key "${k}"`);
    }
  }

  if (rec.version !== 1) {
    throw new Error(`version must be 1, got ${String(rec.version)}`);
  }
  if (!Array.isArray(rec.klines)) {
    throw new Error('klines must be an array');
  }
  if (!Array.isArray(rec.funding)) {
    throw new Error('funding must be an array');
  }

  const allowedKlineKeys = new Set(['symbol', 'day']);
  const klinesMap = new Map<string, KlineJob>();
  for (const raw of rec.klines) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('klines job must be an object');
    }
    const item = raw as Record<string, unknown>;
    for (const k of Object.keys(item)) {
      if (!allowedKlineKeys.has(k)) {
        throw new Error(`Unknown key "${k}" in klines job`);
      }
    }
    const symbol = assertSymbolValid(item.symbol);
    const day = assertDayValid(item.day);
    const key = `${symbol}|${day}`;
    if (!klinesMap.has(key)) {
      klinesMap.set(key, { symbol, day });
    }
  }

  const allowedFundingKeys = new Set(['symbol', 'month']);
  const fundingMap = new Map<string, FundingJob>();
  for (const raw of rec.funding) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('funding job must be an object');
    }
    const item = raw as Record<string, unknown>;
    for (const k of Object.keys(item)) {
      if (!allowedFundingKeys.has(k)) {
        throw new Error(`Unknown key "${k}" in funding job`);
      }
    }
    const symbol = assertSymbolValid(item.symbol);
    const month = assertMonthValid(item.month);
    const key = `${symbol}|${month}`;
    if (!fundingMap.has(key)) {
      fundingMap.set(key, { symbol, month });
    }
  }

  const totalJobs = klinesMap.size + fundingMap.size;
  if (totalJobs > 20_000) {
    throw new Error(`More than 20,000 jobs in total (got ${totalJobs})`);
  }

  const klines = [...klinesMap.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.day.localeCompare(b.day));
  const funding = [...fundingMap.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.month.localeCompare(b.month));

  return { klines, funding };
}

// ---------------------------------------------------------------------------
// Paths and Manifest
// ---------------------------------------------------------------------------

export function klineOutputPath(outDir: string, job: KlineJob): string {
  return join(outDir, 'klines', job.symbol, `${job.symbol}-1m-${job.day}.csv.gz`);
}

export function fundingOutputPath(outDir: string, job: FundingJob): string {
  return join(outDir, 'funding', job.symbol, `${job.symbol}-fundingRate-${job.month}.csv.gz`);
}

/** Reads manifest entries by "kind|symbol|date", the last line winning. */
export function readManifest(manifestPath: string): Map<string, EventManifestEntry> {
  const entries = new Map<string, EventManifestEntry>();
  if (!existsSync(manifestPath)) return entries;
  for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const rec = JSON.parse(line) as EventManifestEntry;
      if (
        (rec.kind === 'klines' || rec.kind === 'funding') &&
        typeof rec.symbol === 'string' &&
        typeof rec.date === 'string'
      ) {
        entries.set(`${rec.kind}|${rec.symbol}|${rec.date}`, rec);
      }
    } catch {
      // Ignore corrupt lines
    }
  }
  return entries;
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

// ---------------------------------------------------------------------------
// Job Processing
// ---------------------------------------------------------------------------

export async function processKlineJob(
  job: KlineJob,
  outDir: string,
  options: ProcessOptions
): Promise<FileOutcome> {
  const finalPath = klineOutputPath(outDir, job);
  const manifestPath = join(outDir, 'manifest.jsonl');
  const key = `klines|${job.symbol}|${job.day}`;

  // A file with no manifest line is never adopted: it could be stale or foreign, so it is downloaded again.
  if (!options.force && hasContent(finalPath)) {
    const existing = options.manifest.get(key);
    if (existing !== undefined && existing.status === 'ok') return 'skipped';
  }

  const lines = await fetchDailyLines(job.symbol, job.day);
  if (lines === null) {
    if (options.manifest.get(key)?.status !== 'missing') {
      const entry: EventManifestEntry = {
        kind: 'klines',
        symbol: job.symbol,
        date: job.day,
        status: 'missing',
        rows: 0,
        firstTs: null,
        lastTs: null,
        gaps: null,
        badRows: 0,
        duplicates: 0,
        sha256: null,
        bytes: 0,
      };
      mkdirSync(outDir, { recursive: true });
      appendFileSync(manifestPath, JSON.stringify(entry) + '\n');
      options.manifest.set(key, entry);
    }
    return 'missing';
  }

  const parsed = parseKlineLines(lines);
  if (parsed.rows.size === 0) {
    throw new Error(`${job.symbol} ${job.day}: daily file held no usable rows`);
  }

  const dayStart = Date.parse(`${job.day}T00:00:00Z`);
  const dayEnd = dayStart + DAY_MS;
  for (const openTime of parsed.rows.keys()) {
    if (openTime < dayStart || openTime >= dayEnd) {
      throw new Error(`${job.symbol} ${job.day}: row open_time ${openTime} is outside UTC day`);
    }
  }

  const shaped = shapeRows(parsed.rows, {
    badRows: parsed.badRows,
    duplicates: parsed.duplicates,
  });

  const bytes = gzipSync(Buffer.from(shaped.csv, 'utf8'));
  mkdirSync(dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, bytes);
    renameSync(tempPath, finalPath);
  } catch (error) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }

  const entry: EventManifestEntry = {
    kind: 'klines',
    symbol: job.symbol,
    date: job.day,
    status: 'ok',
    rows: shaped.rows,
    firstTs: shaped.firstOpenTime,
    lastTs: shaped.lastOpenTime,
    gaps: shaped.gaps,
    badRows: shaped.badRows,
    duplicates: shaped.duplicates,
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
  };
  mkdirSync(outDir, { recursive: true });
  appendFileSync(manifestPath, JSON.stringify(entry) + '\n');
  options.manifest.set(key, entry);
  return 'written';
}

export async function processFundingJob(
  job: FundingJob,
  outDir: string,
  options: ProcessOptions
): Promise<FileOutcome> {
  const finalPath = fundingOutputPath(outDir, job);
  const manifestPath = join(outDir, 'manifest.jsonl');
  const key = `funding|${job.symbol}|${job.month}`;

  // A file with no manifest line is never adopted: it could be stale or foreign, so it is downloaded again.
  if (!options.force && hasContent(finalPath)) {
    const existing = options.manifest.get(key);
    if (existing !== undefined && existing.status === 'ok') return 'skipped';
  }

  let lines: string[] = [];
  const result = await streamArchiveCsvLines(
    { dataset: 'fundingRate', symbol: job.symbol, date: job.month, cadence: 'monthly' },
    (line) => {
      lines.push(line);
    },
    { onRestart: () => (lines = []) }
  );

  if (result.status === 'missing') {
    if (options.manifest.get(key)?.status !== 'missing') {
      const entry: EventManifestEntry = {
        kind: 'funding',
        symbol: job.symbol,
        date: job.month,
        status: 'missing',
        rows: 0,
        firstTs: null,
        lastTs: null,
        gaps: null,
        badRows: 0,
        duplicates: 0,
        sha256: null,
        bytes: 0,
      };
      mkdirSync(outDir, { recursive: true });
      appendFileSync(manifestPath, JSON.stringify(entry) + '\n');
      options.manifest.set(key, entry);
    }
    return 'missing';
  }

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
    if (fields.length < 3) {
      badRows++;
      continue;
    }
    const calcTime = parseArchiveTimestamp(fields[0] ?? '');
    if (!Number.isFinite(calcTime)) {
      badRows++;
      continue;
    }
    if (rows.has(calcTime)) {
      duplicates++;
      continue;
    }
    const interval = (fields[1] ?? '').trim();
    const rate = (fields[2] ?? '').trim();
    rows.set(calcTime, [String(calcTime), interval, rate]);
  }

  if (rows.size === 0) {
    throw new Error(`${job.symbol} ${job.month}: funding file held no usable rows`);
  }

  const times = [...rows.keys()].sort((a, b) => a - b);
  const out: string[] = [FUNDING_OUTPUT_HEADER];
  for (const t of times) {
    out.push(rows.get(t)!.join(','));
  }
  const csv = out.join('\n') + '\n';
  const bytes = gzipSync(Buffer.from(csv, 'utf8'));

  mkdirSync(dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, bytes);
    renameSync(tempPath, finalPath);
  } catch (error) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }

  const entry: EventManifestEntry = {
    kind: 'funding',
    symbol: job.symbol,
    date: job.month,
    status: 'ok',
    rows: times.length,
    firstTs: times[0],
    lastTs: times[times.length - 1],
    gaps: null,
    badRows,
    duplicates,
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
  };
  mkdirSync(outDir, { recursive: true });
  appendFileSync(manifestPath, JSON.stringify(entry) + '\n');
  options.manifest.set(key, entry);
  return 'written';
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
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

export async function runJobs(
  plan: { klines: KlineJob[]; funding: FundingJob[] },
  outDir: string,
  options: { force: boolean; concurrency: number }
): Promise<Summary> {
  mkdirSync(outDir, { recursive: true });
  const manifest = readManifest(join(outDir, 'manifest.jsonl'));
  const summary: Summary = { written: 0, skipped: 0, missing: 0, errors: 0, missingFiles: [], errorFiles: [] };

  type AnyJob =
    | { kind: 'klines'; job: KlineJob; label: string }
    | { kind: 'funding'; job: FundingJob; label: string };

  const jobs: AnyJob[] = [
    ...plan.klines.map((job) => ({ kind: 'klines' as const, job, label: `${job.symbol}-1m-${job.day}` })),
    ...plan.funding.map((job) => ({ kind: 'funding' as const, job, label: `${job.symbol}-fundingRate-${job.month}` })),
  ];

  await forEachWithConcurrency(jobs, options.concurrency, async (item) => {
    try {
      const outcome =
        item.kind === 'klines'
          ? await processKlineJob(item.job, outDir, { force: options.force, manifest })
          : await processFundingJob(item.job, outDir, { force: options.force, manifest });

      if (outcome === 'written') {
        summary.written++;
      } else if (outcome === 'skipped') {
        summary.skipped++;
      } else {
        summary.missing++;
        summary.missingFiles.push(item.label);
      }
    } catch (error) {
      summary.errors++;
      summary.errorFiles.push({ file: item.label, error: errorMessage(error) });
    }
  });

  summary.missingFiles.sort();
  summary.errorFiles.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): EventFetchArgs {
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
    if (!['plan', 'out-dir', 'concurrency'].includes(key)) {
      throw new Error(`Unknown flag "${arg}"`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for "${arg}"`);
    }
    flags.set(key, value);
    i++;
  }

  for (const required of ['plan', 'out-dir']) {
    if (!flags.has(required)) throw new Error(`--${required} is required`);
  }

  let concurrency = DEFAULT_CONCURRENCY;
  if (flags.has('concurrency')) {
    const raw = flags.get('concurrency')!;
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_CONCURRENCY) {
      throw new Error(`--concurrency must be an integer from 1 to ${MAX_CONCURRENCY}, got "${raw}"`);
    }
    concurrency = Number(raw);
  }

  return {
    plan: flags.get('plan')!,
    outDir: flags.get('out-dir')!,
    concurrency,
    force,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const planRaw = JSON.parse(readFileSync(args.plan, 'utf8'));
  const plan = parsePlan(planRaw);

  console.error(`fetch-event-files: ${plan.klines.length} klines, ${plan.funding.length} funding`);
  const summary = await runJobs(plan, args.outDir, { force: args.force, concurrency: args.concurrency });
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
