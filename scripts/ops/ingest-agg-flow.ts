/**
 * Ingests Binance UM aggTrades history into `archiveflowbars` as 5-minute taker
 * flow buckets, for the QH-FLOW research phase (header of scripts/research/qh-flow.ts).
 *
 * Each monthly file (0.06 to 0.73 GB zipped) is streamed, inflated, parsed and
 * folded in memory (a month is under 9,000 buckets) by `foldArchiveFile`. Only
 * after the stream ended and its crc32 and size check passed are the buckets
 * upserted, so a failed stream writes nothing. Raw trades are never stored.
 *
 * Resumable: `archiveflowfiles` holds one ledger row per (symbol, period),
 * written only after all of that file's buckets were. Stop it at any point and
 * run it again: finished files are skipped, anything else is redone, and the
 * bucket upserts are idempotent. A file that fails leaves no row, the run goes
 * on to the next file, and the exit code is 1 at the end.
 *
 * LOCKBOX: nothing from 2026-07 onward is read. Any period at or after it is
 * refused before a download starts. The one opt-in exception is the forward test
 * (scripts/research/forward-test.ts): `--allow-lockbox --max-date YYYY-MM-DD` lifts the
 * refusal for monthly periods and for --daily-repair dates, but still refuses any period
 * starting after, or date later than, --max-date. Default off. (The one declared lockbox exception, the
 * extractor validation, is `validate-agg-flow.ts` and reads daily files.)
 *
 * Usage (from the Docker seeder stage on the VPS, like ingest-archive.ts):
 *   docker run --rm --network crypto_crypto-internal --env-file .env \
 *     crypto-ops:history npx tsx scripts/ops/ingest-agg-flow.ts [flags]
 *
 * Flags:
 *   --symbols BTCUSDT,ETHUSDT   default SIGNAL_SYMBOLS
 *   --from 2023-01              first month, inclusive (default shown)
 *   --to 2026-06                last month, inclusive (default shown, the maximum)
 *   --concurrency 1             files processed at once
 *   --refresh                   re-ingest files already recorded (complete or missing)
 *   --dry-run                   print the job list with its status and exit
 *   --allow-lockbox             forward test only: lift the 2026-07 refusal (monthly periods and
 *                               --daily-repair dates). Needs --max-date. Default off.
 *   --max-date YYYY-MM-DD       with --allow-lockbox: refuse any period starting after, or any
 *                               date later than, this date
 *   --daily-repair BTCUSDT:2024-03-05[,...]
 *                               repair mode: ingest the DAILY aggTrades file of each
 *                               SYMBOL:date (days a monthly file omits), then refresh that
 *                               month's ledger coverage. Nothing else runs. Refuses 2026-07-01 on.
 *
 * One JSON line per file: { symbol, period, status, lines, buckets, outOfOrder, expectedBuckets,
 * missingDays, seconds }, then one { coverage } line per file with missing days, then a final
 * summary line.
 *
 * Month guard: a file whose buckets are not all inside its own month (a boundary trade, a
 * microsecond timestamp) fails with no writes and no ledger row; the error carries the first and
 * last bucketStart. The same guard bounds a daily repair file to its own day.
 */
import type { FlowBucket } from '@/lib/archive-flow/fold';
import { foldArchiveFile } from '@/lib/archive-flow/fold-file';
import { archiveFileName } from '@/lib/external/binance-archive';
import { ArchiveFlowBar } from '@/lib/models/archive-flow-bar';
import { ArchiveFlowFile } from '@/lib/models/archive-flow-file';
import { connectDB } from '@/lib/mongodb';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

export const DEFAULT_FROM = '2023-01';
export const DEFAULT_TO = '2026-06';
/** First period nothing may read: the lockbox starts on 2026-07-01. */
export const LOCKBOX_FIRST_PERIOD = '2026-07';
/** Documents per bulkWrite. */
export const WRITE_CHUNK = 5_000;

/** 5-minute buckets in a UTC day. */
export const BUCKETS_PER_DAY = 288;
const DAY_MS = 86_400_000;
const BUCKET_MS = 300_000;
/** First UTC date nothing may read (the lockbox), for the daily repair mode. */
export const LOCKBOX_FIRST_DATE = '2026-07-01';

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const SYMBOL = /^[A-Z0-9]+$/;

export interface Args {
  symbols: string[];
  from: string;
  to: string;
  concurrency: number;
  refresh: boolean;
  dryRun: boolean;
  dailyRepair: RepairJob[];
  /** Forward test: lockbox periods and dates are allowed up to maxDate. Absent means false. */
  allowLockbox?: boolean;
  /** 'YYYY-MM-DD'; required with allowLockbox. */
  maxDate?: string;
}

/** The opt-in lockbox exception (see the file header). Absent or allowLockbox false means the default refusal. */
export interface LockboxGuard {
  allowLockbox?: boolean;
  maxDate?: string;
}

export interface RepairJob {
  symbol: string;
  /** 'YYYY-MM-DD'. */
  date: string;
}

export interface Job {
  symbol: string;
  period: string;
}

export type LedgerStatus = 'complete' | 'missing';
export type FileStatus = LedgerStatus | 'skipped' | 'error';

export interface FileResult {
  symbol: string;
  period: string;
  status: FileStatus;
  lines: number;
  buckets: number;
  outOfOrder: number;
  expectedBuckets?: number;
  missingDays?: string[];
  seconds: number;
  error?: string;
}

export interface Summary {
  summary: true;
  files: number;
  complete: number;
  missing: number;
  skipped: number;
  failed: number;
  buckets: number;
  outOfOrderFiles: number;
  filesWithMissing: number;
  seconds: number;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

/** Throws unless `period` is 'YYYY-MM' and strictly before the lockbox. Runs before any download. */
export function assertOutsideLockbox(period: string): void {
  if (period >= LOCKBOX_FIRST_PERIOD) {
    throw new Error(
      `Lockbox: period ${period} is at or after ${LOCKBOX_FIRST_PERIOD}, which this ingest never reads`
    );
  }
}

/**
 * assertOutsideLockbox with the forward-test exception: with allowLockbox the lockbox refusal is lifted, but a
 * period whose first day is after maxDate is refused (and maxDate is required).
 */
export function assertPeriodAllowed(period: string, guard: LockboxGuard = {}): void {
  if (!guard.allowLockbox) return assertOutsideLockbox(period);
  if (!guard.maxDate) throw new Error('--allow-lockbox needs --max-date YYYY-MM-DD');
  if (`${period}-01` > guard.maxDate) {
    throw new Error(`Max date: period ${period} starts after --max-date ${guard.maxDate}`);
  }
}

/** assertDateOutsideLockbox with the same forward-test exception: a date later than maxDate is refused. */
export function assertDateAllowed(date: string, guard: LockboxGuard = {}): void {
  if (!guard.allowLockbox) return assertDateOutsideLockbox(date);
  if (!guard.maxDate) throw new Error('--allow-lockbox needs --max-date YYYY-MM-DD');
  if (date > guard.maxDate) {
    throw new Error(`Max date: date ${date} is after --max-date ${guard.maxDate}`);
  }
}

/** Throws unless `date` is 'YYYY-MM-DD' and strictly before the lockbox. */
export function assertDateOutsideLockbox(date: string): void {
  if (date >= LOCKBOX_FIRST_DATE) {
    throw new Error(
      `Lockbox: date ${date} is at or after ${LOCKBOX_FIRST_DATE}, which this ingest never reads`
    );
  }
}

/** Parses 'SYMBOL:YYYY-MM-DD[,...]'. Refuses a bad shape, an impossible date or a lockbox date. */
export function parseRepairList(raw: string, guard: LockboxGuard = {}): RepairJob[] {
  const jobs = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [symbol, date, ...extra] = item.split(':');
      const upper = symbol?.toUpperCase() ?? '';
      if (extra.length > 0 || !SYMBOL.test(upper) || !date || !DATE.test(date)) {
        throw new Error(`--daily-repair items must be SYMBOL:YYYY-MM-DD, got ${item}`);
      }
      if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
        throw new Error(`--daily-repair has an impossible date: ${date}`);
      }
      assertDateAllowed(date, guard);
      return { symbol: upper, date };
    });
  if (jobs.length === 0) throw new Error('--daily-repair is empty');
  return jobs;
}

/** UTC [start, end) in epoch ms of a 'YYYY-MM' period or a 'YYYY-MM-DD' date. */
export function rangeOf(label: string): { start: number; end: number } {
  const year = Number(label.slice(0, 4));
  const month = Number(label.slice(5, 7)) - 1;
  if (label.length === 7)
    return { start: Date.UTC(year, month, 1), end: Date.UTC(year, month + 1, 1) };
  const start = Date.UTC(year, month, Number(label.slice(8, 10)));
  return { start, end: start + DAY_MS };
}

/**
 * Throws unless EVERY bucketStart is in [start, end), naming the first and last bucketStart of the
 * file. Runs before any write, so a boundary trade or a wrong-unit timestamp cannot overwrite a
 * neighbouring file's bucket.
 */
export function assertBucketsInRange(
  label: string,
  buckets: Pick<FlowBucket, 'bucketStart'>[],
  start: number,
  end: number
): void {
  const outside = buckets.filter((b) => b.bucketStart < start || b.bucketStart >= end);
  if (outside.length === 0) return;
  const starts = buckets.map((b) => b.bucketStart);
  const iso = (ms: number): string =>
    Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms);
  throw new Error(
    `${label}: ${outside.length} of ${buckets.length} buckets fall outside ` +
      `[${iso(start)}, ${iso(end)}); first bucketStart ${iso(Math.min(...starts))}, ` +
      `last bucketStart ${iso(Math.max(...starts))}`
  );
}

/** 'YYYY-MM-DD' dates of [start, end) holding fewer than 288 of the given bucket starts. */
export function missingDaysOf(starts: number[], start: number, end: number): string[] {
  const counts = new Map<number, number>();
  for (const bucketStart of starts) {
    if (bucketStart < start || bucketStart >= end) continue;
    const day = start + Math.floor((bucketStart - start) / DAY_MS) * DAY_MS;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (let day = start; day < end; day += DAY_MS) {
    if ((counts.get(day) ?? 0) < BUCKETS_PER_DAY) {
      missing.push(new Date(day).toISOString().slice(0, 10));
    }
  }
  return missing;
}

/** Days in the range x 288. */
export function expectedBucketsOf(start: number, end: number): number {
  return Math.round((end - start) / BUCKET_MS);
}

/** Pure argv parser: no I/O, so it is unit tested directly. */
export function parseArgs(argv: string[]): Args {
  let symbols: string[] = [...SIGNAL_SYMBOLS];
  let from = DEFAULT_FROM;
  let to = DEFAULT_TO;
  let concurrency = 1;
  let refresh = false;
  let dryRun = false;
  let dailyRepairRaw: string | undefined;
  let allowLockbox = false;
  let maxDate: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--symbols': {
        symbols = nextValue(argv, ++i, flag)
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);
        break;
      }
      case '--from':
        from = nextValue(argv, ++i, flag);
        break;
      case '--to':
        to = nextValue(argv, ++i, flag);
        break;
      case '--concurrency': {
        const raw = nextValue(argv, ++i, flag);
        concurrency = Number(raw);
        if (!Number.isInteger(concurrency) || concurrency < 1) {
          throw new Error(`--concurrency must be a positive integer, got ${raw}`);
        }
        break;
      }
      case '--refresh':
        refresh = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--daily-repair':
        dailyRepairRaw = nextValue(argv, ++i, flag);
        break;
      case '--allow-lockbox':
        allowLockbox = true;
        break;
      case '--max-date':
        maxDate = nextValue(argv, ++i, flag);
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  if (symbols.length === 0) throw new Error('--symbols is empty');
  for (const symbol of symbols) {
    if (!SYMBOL.test(symbol)) throw new Error(`Invalid symbol: ${symbol}`);
  }
  for (const [flag, value] of [
    ['--from', from],
    ['--to', to],
  ] as const) {
    if (!PERIOD.test(value)) throw new Error(`${flag} must be YYYY-MM, got ${value}`);
  }
  if (maxDate !== undefined) {
    if (!DATE.test(maxDate) || new Date(`${maxDate}T00:00:00Z`).toISOString().slice(0, 10) !== maxDate) {
      throw new Error(`--max-date must be a valid YYYY-MM-DD, got ${maxDate}`);
    }
  }
  if (allowLockbox && maxDate === undefined) throw new Error('--allow-lockbox needs --max-date YYYY-MM-DD');
  const guard: LockboxGuard = { allowLockbox, maxDate };
  assertPeriodAllowed(from, guard);
  assertPeriodAllowed(to, guard);
  if (from > to) throw new Error(`--from ${from} is after --to ${to}`);
  const dailyRepair = dailyRepairRaw === undefined ? [] : parseRepairList(dailyRepairRaw, guard);

  return {
    symbols,
    from,
    to,
    concurrency,
    refresh,
    dryRun,
    dailyRepair,
    ...(allowLockbox ? { allowLockbox: true } : {}),
    ...(maxDate ? { maxDate } : {}),
  };
}

/** Every 'YYYY-MM' from `from` to `to`, inclusive. */
export function periodsBetween(from: string, to: string): string[] {
  const periods: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  for (;;) {
    const period = `${year}-${String(month).padStart(2, '0')}`;
    if (period > to) break;
    periods.push(period);
    if (++month > 12) {
      month = 1;
      year++;
    }
  }
  return periods;
}

/** Symbol-major, period ascending. Refuses a lockbox period outright. */
export function buildJobs(args: Pick<Args, 'symbols' | 'from' | 'to'> & LockboxGuard): Job[] {
  const periods = periodsBetween(args.from, args.to);
  for (const period of periods) assertPeriodAllowed(period, args);
  return args.symbols.flatMap((symbol) => periods.map((period) => ({ symbol, period })));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

interface LedgerEntry {
  status: LedgerStatus;
  expectedBuckets: number;
  missingDays: string[];
}

async function ledgerStatuses(jobs: Job[]): Promise<Map<string, LedgerEntry>> {
  const symbols = [...new Set(jobs.map((j) => j.symbol))];
  const rows = await ArchiveFlowFile.find({ symbol: { $in: symbols } })
    .select('symbol period status expectedBuckets missingDays')
    .lean();
  return new Map(
    rows.map((r) => [
      `${r.symbol}|${r.period}`,
      {
        status: r.status as LedgerStatus,
        expectedBuckets: r.expectedBuckets ?? 0,
        missingDays: r.missingDays ?? [],
      },
    ])
  );
}

async function writeBuckets(symbol: string, source: string, buckets: FlowBucket[]): Promise<void> {
  for (let i = 0; i < buckets.length; i += WRITE_CHUNK) {
    const chunk = buckets.slice(i, i + WRITE_CHUNK).map((bucket) => ({
      updateOne: {
        filter: { symbol, bucketStart: bucket.bucketStart },
        update: { $set: { ...bucket, symbol, source } },
        upsert: true,
      },
    }));
    await ArchiveFlowBar.bulkWrite(chunk, { ordered: false });
  }
}

/** Ingest one file. Never throws: a failure is returned as status 'error' and leaves no ledger row. */
export async function ingestFile(job: Job, guard: LockboxGuard = {}): Promise<FileResult> {
  const t0 = Date.now();
  const startedAt = new Date();
  const result = (r: Partial<FileResult> & { status: FileStatus }): FileResult => ({
    symbol: job.symbol,
    period: job.period,
    lines: 0,
    buckets: 0,
    outOfOrder: 0,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    ...r,
  });

  try {
    assertPeriodAllowed(job.period, guard);
    const spec = { dataset: 'aggTrades', symbol: job.symbol, date: job.period } as const;
    const key = { symbol: job.symbol, period: job.period };

    // The stream has ended and passed its integrity check before this returns.
    const folded = await foldArchiveFile(spec);
    if (folded.status === 'missing') {
      await ArchiveFlowFile.updateOne(
        key,
        {
          $set: {
            status: 'missing',
            lines: 0,
            buckets: 0,
            outOfOrder: 0,
            bytesUncompressed: 0,
            expectedBuckets: 0,
            missingDays: [],
            crcOk: false,
            startedAt,
            completedAt: new Date(),
          },
        },
        { upsert: true }
      );
      return result({ status: 'missing' });
    }

    // Before any write: every bucket must belong to this file's own month.
    const { start, end } = rangeOf(job.period);
    assertBucketsInRange(`${job.symbol} ${job.period}`, folded.buckets, start, end);
    const expectedBuckets = expectedBucketsOf(start, end);
    const missingDays = missingDaysOf(
      folded.buckets.map((b) => b.bucketStart),
      start,
      end
    );

    await writeBuckets(job.symbol, archiveFileName(spec), folded.buckets);

    // Last: a row means every bucket above was written.
    await ArchiveFlowFile.updateOne(
      key,
      {
        $set: {
          status: 'complete',
          lines: folded.lines,
          buckets: folded.buckets.length,
          outOfOrder: folded.outOfOrder,
          bytesUncompressed: folded.uncompressedBytes,
          expectedBuckets,
          missingDays,
          crcOk: true,
          startedAt,
          completedAt: new Date(),
        },
      },
      { upsert: true }
    );
    return result({
      status: 'complete',
      lines: folded.lines,
      buckets: folded.buckets.length,
      outOfOrder: folded.outOfOrder,
      expectedBuckets,
      missingDays,
    });
  } catch (error) {
    return result({ status: 'error', error: errorMessage(error) });
  }
}

export interface RepairResult {
  repair: true;
  symbol: string;
  date: string;
  status: 'repaired' | 'missing' | 'error';
  buckets: number;
  outOfOrder: number;
  seconds: number;
  error?: string;
}

/** Recomputes a month's ledger coverage from the stored buckets (after a repair). No-op without a row. */
async function refreshCoverage(symbol: string, period: string): Promise<void> {
  const { start, end } = rangeOf(period);
  const docs = await ArchiveFlowBar.find({ symbol, bucketStart: { $gte: start, $lt: end } })
    .select('bucketStart')
    .lean();
  await ArchiveFlowFile.updateOne(
    { symbol, period, status: 'complete' },
    {
      $set: {
        expectedBuckets: expectedBucketsOf(start, end),
        missingDays: missingDaysOf(
          docs.map((d) => d.bucketStart),
          start,
          end
        ),
      },
    }
  );
}

/** Ingest one DAILY aggTrades file with the same fold and a day-bounded guard. Never throws. */
export async function repairDay(job: RepairJob, guard: LockboxGuard = {}): Promise<RepairResult> {
  const t0 = Date.now();
  const result = (r: Partial<RepairResult> & { status: RepairResult['status'] }): RepairResult => ({
    repair: true,
    symbol: job.symbol,
    date: job.date,
    buckets: 0,
    outOfOrder: 0,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    ...r,
  });
  try {
    assertDateAllowed(job.date, guard);
    const spec = {
      dataset: 'aggTrades',
      symbol: job.symbol,
      date: job.date,
      cadence: 'daily',
    } as const;
    const folded = await foldArchiveFile(spec);
    if (folded.status === 'missing') return result({ status: 'missing' });

    const { start, end } = rangeOf(job.date);
    assertBucketsInRange(`${job.symbol} ${job.date}`, folded.buckets, start, end);
    await writeBuckets(job.symbol, archiveFileName(spec), folded.buckets);
    await refreshCoverage(job.symbol, job.date.slice(0, 7));
    return result({
      status: 'repaired',
      buckets: folded.buckets.length,
      outOfOrder: folded.outOfOrder,
    });
  } catch (error) {
    return result({ status: 'error', error: errorMessage(error) });
  }
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

/** Runs the ingest and returns the process exit code. Nothing is downloaded before the lockbox check. */
export async function run(
  args: Args,
  log: (line: object) => void = (l) => console.log(JSON.stringify(l))
): Promise<number> {
  const t0 = Date.now();
  const guard: LockboxGuard = { allowLockbox: args.allowLockbox, maxDate: args.maxDate };
  if (args.allowLockbox) {
    log({ lockbox: 'allowed', maxDate: args.maxDate, note: 'forward test: lockbox periods and dates are read up to --max-date' });
  }
  if (args.dailyRepair.length > 0) {
    for (const job of args.dailyRepair) assertDateAllowed(job.date, guard);
    let failed = 0;
    await runPool(args.dailyRepair, args.concurrency, async (job) => {
      const result = await repairDay(job, guard);
      if (result.status === 'error') failed++;
      log(result);
    });
    return failed > 0 ? 1 : 0;
  }

  const jobs = buildJobs({ ...args, ...guard });
  const statuses = await ledgerStatuses(jobs);

  if (args.dryRun) {
    for (const job of jobs) {
      log({ ...job, status: statuses.get(`${job.symbol}|${job.period}`)?.status ?? 'pending' });
    }
    return 0;
  }

  const results: FileResult[] = [];
  await runPool(jobs, args.concurrency, async (job) => {
    const recorded = statuses.get(`${job.symbol}|${job.period}`);
    const result: FileResult =
      recorded && !args.refresh
        ? {
            ...job,
            status: 'skipped',
            lines: 0,
            buckets: 0,
            outOfOrder: 0,
            expectedBuckets: recorded.expectedBuckets,
            missingDays: recorded.missingDays,
            seconds: 0,
          }
        : await ingestFile(job, guard);
    results.push(result);
    const { error, ...line } = result;
    log(error ? { ...line, error } : line);
  });

  const withMissing = results.filter((r) => (r.missingDays?.length ?? 0) > 0);
  for (const r of withMissing) {
    log({
      coverage: true,
      symbol: r.symbol,
      period: r.period,
      expectedBuckets: r.expectedBuckets,
      missingDays: r.missingDays,
    });
  }

  const count = (status: FileStatus): number => results.filter((r) => r.status === status).length;
  const summary: Summary = {
    summary: true,
    files: results.length,
    complete: count('complete'),
    missing: count('missing'),
    skipped: count('skipped'),
    failed: count('error'),
    buckets: results.reduce((sum, r) => sum + r.buckets, 0),
    outOfOrderFiles: results.filter((r) => r.outOfOrder > 0).length,
    filesWithMissing: withMissing.length,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
  };
  log(summary);
  return summary.failed > 0 ? 1 : 0;
}

export async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  await connectDB();
  return run(args);
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
