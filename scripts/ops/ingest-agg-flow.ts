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
 * refused before a download starts. (The one declared lockbox exception, the
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
 *
 * One JSON line per file: { symbol, period, status, lines, buckets, outOfOrder, seconds },
 * then a final summary line.
 */
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

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const SYMBOL = /^[A-Z0-9]+$/;

export interface Args {
  symbols: string[];
  from: string;
  to: string;
  concurrency: number;
  refresh: boolean;
  dryRun: boolean;
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

/** Pure argv parser: no I/O, so it is unit tested directly. */
export function parseArgs(argv: string[]): Args {
  let symbols: string[] = [...SIGNAL_SYMBOLS];
  let from = DEFAULT_FROM;
  let to = DEFAULT_TO;
  let concurrency = 1;
  let refresh = false;
  let dryRun = false;

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
  assertOutsideLockbox(from);
  assertOutsideLockbox(to);
  if (from > to) throw new Error(`--from ${from} is after --to ${to}`);

  return { symbols, from, to, concurrency, refresh, dryRun };
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
export function buildJobs(args: Pick<Args, 'symbols' | 'from' | 'to'>): Job[] {
  const periods = periodsBetween(args.from, args.to);
  for (const period of periods) assertOutsideLockbox(period);
  return args.symbols.flatMap((symbol) => periods.map((period) => ({ symbol, period })));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function ledgerStatuses(jobs: Job[]): Promise<Map<string, LedgerStatus>> {
  const symbols = [...new Set(jobs.map((j) => j.symbol))];
  const rows = await ArchiveFlowFile.find({ symbol: { $in: symbols } })
    .select('symbol period status')
    .lean();
  return new Map(rows.map((r) => [`${r.symbol}|${r.period}`, r.status as LedgerStatus]));
}

/** Ingest one file. Never throws: a failure is returned as status 'error' and leaves no ledger row. */
export async function ingestFile(job: Job): Promise<FileResult> {
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
    assertOutsideLockbox(job.period);
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
            crcOk: false,
            startedAt,
            completedAt: new Date(),
          },
        },
        { upsert: true }
      );
      return result({ status: 'missing' });
    }

    const source = archiveFileName(spec);
    for (let i = 0; i < folded.buckets.length; i += WRITE_CHUNK) {
      const chunk = folded.buckets.slice(i, i + WRITE_CHUNK).map((bucket) => ({
        updateOne: {
          filter: { symbol: job.symbol, bucketStart: bucket.bucketStart },
          update: { $set: { ...bucket, symbol: job.symbol, source } },
          upsert: true,
        },
      }));
      await ArchiveFlowBar.bulkWrite(chunk, { ordered: false });
    }

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
  const jobs = buildJobs(args);
  const t0 = Date.now();
  const statuses = await ledgerStatuses(jobs);

  if (args.dryRun) {
    for (const job of jobs) {
      log({ ...job, status: statuses.get(`${job.symbol}|${job.period}`) ?? 'pending' });
    }
    return 0;
  }

  const results: FileResult[] = [];
  await runPool(jobs, args.concurrency, async (job) => {
    const recorded = statuses.get(`${job.symbol}|${job.period}`);
    const result: FileResult =
      recorded && !args.refresh
        ? { ...job, status: 'skipped', lines: 0, buckets: 0, outOfOrder: 0, seconds: 0 }
        : await ingestFile(job);
    results.push(result);
    const { error, ...line } = result;
    log(error ? { ...line, error } : line);
  });

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
