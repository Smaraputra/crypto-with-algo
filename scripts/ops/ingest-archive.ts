/**
 * Ingests Binance public data archive history into production Mongo.
 *
 * Why this exists: the REST endpoints in `src/lib/binance-futures.ts` serve
 * `futures/data/*` for roughly the last 30 days (`RECENT_FUTURES_LIMIT` in
 * `src/lib/snapshot-backfill.ts`, whose own header says so), so stored
 * `longShortRatio` and `openInterest` cover 11.0% of 1h bars and 6.9% of 4h
 * and 1d bars, none of it before 2026-03-03. The Phase 3 factor study
 * therefore judged those inputs on about four months under the lockbox, and
 * open interest never reached the scorer at all. The archive carries the same
 * series on a 5m grid back to 2021.
 *
 * It also brings in the perpetual price series. `Candle` holds SPOT bars
 * (`src/lib/candle-ingestion.ts` fetches through `src/lib/binance.ts`, base
 * `https://api.binance.com/api/v3`) while every backtest charges USDT-M
 * perpetual fees, slippage and funding. Perp bars land in `PerpCandle`
 * alongside, so the mismatch can be measured instead of assumed.
 *
 * Datasets, and what each one writes:
 *
 *   metrics       FuturesMetric, one document per 5m slot
 *   bookDepth     the depth fields of the same FuturesMetric documents
 *   klines        PerpCandle, series 'klines'
 *   premiumIndex  PerpCandle, series 'premiumIndex'
 *   markPrice     PerpCandle, series 'markPrice'
 *   fundingRate   HistoricalSnapshot.data.fundingRate
 *   snapshots     HistoricalSnapshot.data.longShortRatio and .openInterest,
 *                 read back out of FuturesMetric, so it can run on its own
 *                 after a metrics pass
 *
 * `bookTicker` is not supported: the bucket lists the prefix but serves no
 * files for UM futures (404 across 2022 to 2025, daily and monthly, checked
 * 2026-09-20). `aggTrades` is not supported either, at about 408 MB per
 * symbol-month, because the kline row already carries taker buy volume.
 *
 * Every write is an idempotent upsert on the collection's unique key, and every
 * download is cached on disk, so a re-run costs nothing and resumes cleanly.
 *
 * Usage (from the Docker seeder stage on the VPS, like backfill-history.ts):
 *   docker run --rm --network crypto_crypto-internal --env-file .env \
 *     crypto-ops:history npx tsx scripts/ops/ingest-archive.ts [flags]
 *
 * Flags:
 *   --datasets metrics,snapshots                comma list (default shown)
 *   --symbols BTCUSDT,ETHUSDT                   default SIGNAL_SYMBOLS
 *   --intervals 5m,15m,1h,4h,1d                 for the kline-shaped datasets
 *   --snapshot-intervals 1h,4h,1d               for the snapshots backfill
 *   --from 2021-01-01                           inclusive, default 2021-01-01
 *   --to 2026-09-19                             inclusive, default yesterday
 *   --cache-dir data/archive-cache              downloaded zips
 *   --concurrency 8                             parallel downloads per job
 *   --refresh                                   re-download cached files
 *   --dry-run                                   print the job list only
 */
import { connectDB } from '@/lib/mongodb';
import {
  ARCHIVE_CADENCE,
  fetchArchiveFile,
  parseBookDepthCsv,
  parseFundingCsv,
  parseKlineCsv,
  parseMetricsCsv,
  type ArchiveDataset,
} from '@/lib/external/binance-archive';
import {
  aggregateBookDepth,
  barGrid,
  buildMetricsSnapshotPatches,
  depthUpserts,
  enumerateDays,
  enumerateMonths,
  metricsUpserts,
  perpCandleUpserts,
  type UpsertOp,
} from '@/lib/archive-ingestion';
import { bulkUpsertSnapshots } from '@/lib/historical-snapshots';
import { FuturesMetric } from '@/lib/models/futures-metric';
import { PerpCandle, type PerpSeries } from '@/lib/models/perp-candle';
import { VALID_INTERVALS } from '@/lib/models/candle';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { alignTimestamp } from '@/lib/historical-snapshots';
import { intervalToMs } from '@/lib/intervals';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Documents per bulkWrite. 5m metrics for a year is about 105,000 rows. */
const WRITE_CHUNK = 5000;
/** A funding event settles every 8h; beyond that plus one bar it is stale. */
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

/** The `snapshots` job is ours, not an archive dataset. */
export type JobKind = ArchiveDataset | 'snapshots';

export const DATASET_KINDS: readonly JobKind[] = [
  'metrics',
  'bookDepth',
  'klines',
  'premiumIndex',
  'markPrice',
  'fundingRate',
  'snapshots',
] as const;

/** Datasets whose archive path carries an interval segment. */
const INTERVAL_KINDS = new Set<JobKind>(['klines', 'premiumIndex', 'markPrice']);
/** Which PerpCandle series each kline-shaped dataset writes. */
const SERIES_FOR_KIND: Partial<Record<JobKind, PerpSeries>> = {
  klines: 'klines',
  premiumIndex: 'premiumIndex',
  markPrice: 'markPrice',
};

export interface ParsedArgs {
  datasets: JobKind[];
  symbols: string[];
  intervals: string[];
  snapshotIntervals: string[];
  fromMs: number;
  toMs: number;
  cacheDir: string;
  concurrency: number;
  refresh: boolean;
  dryRun: boolean;
}

export interface Job {
  kind: JobKind;
  symbol: string;
  interval?: string;
  fromMs: number;
  toMs: number;
}

const DEFAULT_DATASETS = 'metrics,snapshots';
const DEFAULT_INTERVALS = '5m,15m,1h,4h,1d';
const DEFAULT_SNAPSHOT_INTERVALS = '1h,4h,1d';
const DEFAULT_CACHE_DIR = 'data/archive-cache';
const DEFAULT_CONCURRENCY = 8;
/** The archive's own floor: nothing under UM futures predates 2020. */
const DEFAULT_FROM = '2021-01-01';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDay(value: string, flag: string): number {
  if (!ISO_DAY.test(value)) throw new Error(`${flag}: expected YYYY-MM-DD, got "${value}"`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`${flag}: "${value}" is not a real date`);
  return ms;
}

function parseList(spec: string, flag: string): string[] {
  const out = spec
    .split(',')
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (out.length === 0) throw new Error(`${flag} requires at least one value`);
  return out;
}

/** The value for a flag that takes one: missing, or looking like another flag, is an error. */
function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** Pure argv parser: no I/O, so it is unit tested directly. */
export function parseArgs(argv: string[], now: Date = new Date()): ParsedArgs {
  let datasetsSpec = DEFAULT_DATASETS;
  let symbolsSpec: string | null = null;
  let intervalsSpec = DEFAULT_INTERVALS;
  let snapshotIntervalsSpec = DEFAULT_SNAPSHOT_INTERVALS;
  let fromSpec = DEFAULT_FROM;
  let toSpec: string | null = null;
  let cacheDir = DEFAULT_CACHE_DIR;
  let concurrency = DEFAULT_CONCURRENCY;
  let refresh = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--datasets':
        datasetsSpec = nextValue(argv, ++i, '--datasets');
        break;
      case '--symbols':
        symbolsSpec = nextValue(argv, ++i, '--symbols');
        break;
      case '--intervals':
        intervalsSpec = nextValue(argv, ++i, '--intervals');
        break;
      case '--snapshot-intervals':
        snapshotIntervalsSpec = nextValue(argv, ++i, '--snapshot-intervals');
        break;
      case '--from':
        fromSpec = nextValue(argv, ++i, '--from');
        break;
      case '--to':
        toSpec = nextValue(argv, ++i, '--to');
        break;
      case '--cache-dir':
        cacheDir = nextValue(argv, ++i, '--cache-dir');
        break;
      case '--concurrency': {
        const raw = nextValue(argv, ++i, '--concurrency');
        if (!/^\d+$/.test(raw) || Number(raw) < 1) {
          throw new Error(`--concurrency must be a positive integer, got "${raw}"`);
        }
        concurrency = Number(raw);
        break;
      }
      case '--refresh':
        refresh = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        throw new Error(`Unknown flag "${flag}"`);
    }
  }

  const datasets = parseList(datasetsSpec, '--datasets').map((name) => {
    if (!(DATASET_KINDS as readonly string[]).includes(name)) {
      throw new Error(`--datasets: unknown dataset "${name}", expected one of ${DATASET_KINDS.join(', ')}`);
    }
    return name as JobKind;
  });

  const intervals = parseList(intervalsSpec, '--intervals').map((interval) => {
    if (!(VALID_INTERVALS as readonly string[]).includes(interval)) {
      throw new Error(`--intervals: unknown interval "${interval}"`);
    }
    return interval;
  });

  const snapshotIntervals = parseList(snapshotIntervalsSpec, '--snapshot-intervals').map((interval) => {
    if (!(VALID_INTERVALS as readonly string[]).includes(interval)) {
      throw new Error(`--snapshot-intervals: unknown interval "${interval}"`);
    }
    return interval;
  });

  const fromMs = parseIsoDay(fromSpec, '--from');
  // Default: yesterday. The archive publishes a day's file after that day ends,
  // so today's file does not exist yet and asking for it is a guaranteed 404.
  const toMs = toSpec
    ? parseIsoDay(toSpec, '--to')
    : Math.floor((now.getTime() - DAY_MS) / DAY_MS) * DAY_MS;

  if (toMs < fromMs) {
    throw new Error(`--to (${new Date(toMs).toISOString().slice(0, 10)}) is before --from`);
  }

  return {
    datasets,
    symbols: symbolsSpec ? parseList(symbolsSpec, '--symbols') : [...SIGNAL_SYMBOLS],
    intervals,
    snapshotIntervals,
    fromMs,
    toMs,
    cacheDir,
    concurrency,
    refresh,
    dryRun,
  };
}

/**
 * Ordered job list, dataset-major.
 *
 * `snapshots` is emitted last whatever order the flag gave, because it reads
 * the FuturesMetric rows a `metrics` job in the same run has just written.
 */
export function buildJobs(args: ParsedArgs): Job[] {
  const jobs: Job[] = [];
  const ordered = [
    ...args.datasets.filter((d) => d !== 'snapshots'),
    ...args.datasets.filter((d) => d === 'snapshots'),
  ];

  for (const kind of ordered) {
    for (const symbol of args.symbols) {
      if (kind === 'snapshots') {
        for (const interval of args.snapshotIntervals) {
          jobs.push({ kind, symbol, interval, fromMs: args.fromMs, toMs: args.toMs });
        }
      } else if (INTERVAL_KINDS.has(kind)) {
        for (const interval of args.intervals) {
          jobs.push({ kind, symbol, interval, fromMs: args.fromMs, toMs: args.toMs });
        }
      } else {
        jobs.push({ kind, symbol, fromMs: args.fromMs, toMs: args.toMs });
      }
    }
  }

  return jobs;
}

/** The archive file keys one job needs, oldest first. */
export function jobFileKeys(job: Job): string[] {
  if (job.kind === 'snapshots') return [];
  return ARCHIVE_CADENCE[job.kind] === 'daily'
    ? enumerateDays(job.fromMs, job.toMs)
    : enumerateMonths(job.fromMs, job.toMs);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/**
 * Run `worker` over `items` with at most `limit` in flight, keeping no results.
 *
 * Nothing is accumulated on purpose. An earlier version collected every
 * downloaded CSV into an array and ingested afterwards, which held a whole
 * job's files in memory at once: fine for metrics (about 35 KB decompressed
 * per day) but fatal for bookDepth, where 1,723 days of roughly 2 MB each is
 * about 3.4 GB and Node's default heap is 2 GB. That is a real production
 * failure, not a theoretical one, and the fix is for each worker to download
 * and ingest one file before taking the next, so a job holds at most `limit`
 * files however many days it covers.
 */
async function forEachWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;

  async function run(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

async function writeFuturesMetrics<T extends object>(ops: UpsertOp<T>[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < ops.length; i += WRITE_CHUNK) {
    const chunk = ops.slice(i, i + WRITE_CHUNK).map((op) => ({
      updateOne: { filter: op.filter, update: { $set: op.set }, upsert: true },
    }));
    const result = await FuturesMetric.bulkWrite(chunk, { ordered: false });
    written += (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0);
  }
  return written;
}

async function writePerpCandles<T extends object>(ops: UpsertOp<T>[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < ops.length; i += WRITE_CHUNK) {
    const chunk = ops.slice(i, i + WRITE_CHUNK).map((op) => ({
      updateOne: { filter: op.filter, update: { $set: op.set }, upsert: true },
    }));
    const result = await PerpCandle.bulkWrite(chunk, { ordered: false });
    written += (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0);
  }
  return written;
}

export async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const jobs = buildJobs(args);

  if (args.dryRun) {
    for (const job of jobs) {
      console.log(JSON.stringify({ ...job, files: jobFileKeys(job).length }));
    }
    return 0;
  }

  await connectDB();

  let hasError = false;
  const fetchOptions = { cacheDir: args.cacheDir, refresh: args.refresh };

  for (const job of jobs) {
    const started = Date.now();
    try {
      if (job.kind === 'snapshots') {
        const summary = await runSnapshotJob(job);
        console.log(JSON.stringify({ kind: job.kind, symbol: job.symbol, interval: job.interval, ...summary, ms: Date.now() - started }));
        continue;
      }

      const keys = jobFileKeys(job);
      let missing = 0;
      let rows = 0;
      let written = 0;

      // Each worker downloads one file, ingests it, then takes the next, so a
      // job's memory is bounded by the concurrency rather than by how many
      // days it covers. Counters are incremented from several workers, which
      // is safe: every await point hands control back to the event loop, and
      // these are plain additions on a single thread.
      await forEachWithConcurrency(keys, args.concurrency, async (date) => {
        const csv = await fetchArchiveFile(
          { dataset: job.kind as ArchiveDataset, symbol: job.symbol, interval: job.interval, date },
          fetchOptions
        );
        if (csv === null) {
          missing++;
          return;
        }
        const result = await ingestCsv(job, csv);
        rows += result.rows;
        written += result.written;
      });

      console.log(JSON.stringify({
        kind: job.kind,
        symbol: job.symbol,
        interval: job.interval,
        files: keys.length,
        missing,
        rows,
        written,
        from: keys[0] ?? null,
        to: keys[keys.length - 1] ?? null,
        ms: Date.now() - started,
      }));
    } catch (error) {
      hasError = true;
      console.log(JSON.stringify({
        kind: job.kind,
        symbol: job.symbol,
        interval: job.interval,
        error: errorMessage(error),
      }));
    }
  }

  return hasError ? 1 : 0;
}

async function ingestCsv(job: Job, csv: string): Promise<{ rows: number; written: number }> {
  switch (job.kind) {
    case 'metrics': {
      const parsed = parseMetricsCsv(csv);
      const ops = metricsUpserts(job.symbol, parsed);
      return { rows: parsed.length, written: await writeFuturesMetrics(ops) };
    }
    case 'bookDepth': {
      const parsed = parseBookDepthCsv(csv);
      const ops = depthUpserts(job.symbol, aggregateBookDepth(parsed));
      return { rows: parsed.length, written: await writeFuturesMetrics(ops) };
    }
    case 'klines':
    case 'premiumIndex':
    case 'markPrice': {
      const series = SERIES_FOR_KIND[job.kind];
      if (!series || !job.interval) {
        throw new Error(`Internal error: ${job.kind} job has no series or interval`);
      }
      const parsed = parseKlineCsv(csv);
      const ops = perpCandleUpserts(job.symbol, job.interval, series, parsed);
      return { rows: parsed.length, written: await writePerpCandles(ops) };
    }
    case 'fundingRate': {
      const parsed = parseFundingCsv(csv);
      return { rows: parsed.length, written: await writeFundingSnapshots(job.symbol, parsed) };
    }
    default:
      throw new Error(`Internal error: no ingest path for ${job.kind}`);
  }
}

/**
 * Funding events onto every snapshot interval's bar grid.
 *
 * Funding settles every 8h, so one event stands for the bars until the next
 * one; beyond 8h plus one bar it is stale, the same cap `snapshot-backfill.ts`
 * applies. Only `data.fundingRate` is written, so live-captured news and Fear
 * and Greed on those bars survive (`bulkUpsertSnapshots` merges field by field).
 */
async function writeFundingSnapshots(
  symbol: string,
  events: Array<{ timestamp: number; rate: number }>
): Promise<number> {
  if (events.length === 0) return 0;

  let written = 0;
  for (const interval of ['1h', '4h', '1d']) {
    const intervalMs = intervalToMs(interval);
    const first = alignTimestamp(events[0].timestamp, interval);
    const last = alignTimestamp(events[events.length - 1].timestamp, interval);
    const bars = barGrid(first, last, interval);
    const maxStaleness = FUNDING_INTERVAL_MS + intervalMs;

    const patches: Array<{ symbol: string; interval: string; timestamp: number; data: { fundingRate: { rate: number } } }> = [];
    let cursor = 0;
    let latest: { timestamp: number; rate: number } | null = null;
    for (const bar of bars) {
      while (cursor < events.length && events[cursor].timestamp <= bar) {
        latest = events[cursor];
        cursor++;
      }
      if (latest && bar - latest.timestamp <= maxStaleness) {
        patches.push({ symbol, interval, timestamp: bar, data: { fundingRate: { rate: latest.rate } } });
      }
    }

    for (let i = 0; i < patches.length; i += WRITE_CHUNK) {
      await bulkUpsertSnapshots(patches.slice(i, i + WRITE_CHUNK));
    }
    written += patches.length;
  }
  return written;
}

/**
 * Fill `longShortRatio` and `openInterest` on stored snapshots from the
 * FuturesMetric rows a metrics pass has already written.
 *
 * Reading them back out of Mongo rather than off disk means this job can run on
 * its own, long after the download, and that it patches exactly the history
 * that was actually stored.
 */
async function runSnapshotJob(job: Job): Promise<{ metrics: number; bars: number; patched: number }> {
  if (!job.interval) throw new Error('Internal error: snapshots job has no interval');

  const metrics = await FuturesMetric.find(
    { symbol: job.symbol, timestamp: { $gte: job.fromMs, $lte: job.toMs + DAY_MS } },
    {
      timestamp: 1,
      openInterest: 1,
      openInterestValue: 1,
      topTraderPositionRatio: 1,
      _id: 0,
    }
  )
    .sort({ timestamp: 1 })
    .lean();

  if (metrics.length === 0) return { metrics: 0, bars: 0, patched: 0 };

  const bars = barGrid(metrics[0].timestamp, metrics[metrics.length - 1].timestamp, job.interval);
  const patches = buildMetricsSnapshotPatches({
    symbol: job.symbol,
    interval: job.interval,
    bars,
    metrics,
  });

  for (let i = 0; i < patches.length; i += WRITE_CHUNK) {
    await bulkUpsertSnapshots(patches.slice(i, i + WRITE_CHUNK));
  }

  return { metrics: metrics.length, bars: bars.length, patched: patches.length };
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
