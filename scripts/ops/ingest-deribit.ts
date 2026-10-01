/**
 * Ingests Deribit DVOL and option-trade history into production Mongo.
 *
 * Why this exists: the options market carries information the perp-only
 * signal path never sees -- implied vol, skew, and who is paying to cross the
 * spread in calls versus puts. `src/lib/external/deribit.ts` (Task 3a) can
 * fetch both series from Deribit's public JSON-RPC API; this CLI is what
 * turns a fetch into stored history, following `scripts/ops/ingest-archive.ts`
 * for the job/log/resume shape and `src/lib/perp-candles.ts` for the write
 * path.
 *
 * Datasets, and what each one writes (both land in `OptionsFlowHour`, see
 * that model's header for why the two passes merge into one document):
 *
 *   dvol    one `fetchDvol` call per currency over the whole range, hourly
 *           resolution, upserted through `dvolUpserts` -- writes only
 *           `dvolOpen/High/Low/Close`
 *   trades  one `fetchOptionTrades` call per currency PER DAY (the history
 *           endpoint has no coarser aggregate), bucketed into hourly rows by
 *           `aggregateOptionTrades` and upserted through `flowUpserts` --
 *           writes everything else on the model
 *
 * Raw option trades are never written to Mongo: `aggregateOptionTrades`
 * folds a day's trades into hourly notional, delta, gamma and iv figures
 * before anything is stored, the same rule `options-flow.ts`'s header states.
 *
 * The trades job is the expensive one (20k-30k trades a day per currency,
 * fetched with a rate limit), so it resumes at day granularity: a day whose
 * fetch, aggregate and write have all completed gets an empty marker file at
 * `<cacheDir>/trades/<CURRENCY>/<YYYY-MM-DD>.done`, and a re-run skips any day
 * that already has one (`--refresh` ignores markers and re-fetches
 * everything). A day is only marked done once it has fully elapsed (ended at
 * least an hour before the run started): marking today's still-accumulating
 * day done would freeze it at a partial trade count forever, since nothing
 * would ever re-fetch it. The dvol job has no such marker: one call per
 * currency covers the whole range, so there is nothing partial to resume.
 *
 * Every write is an idempotent upsert on the model's unique key, so a re-run
 * costs nothing beyond the fetch it repeats.
 *
 * Usage (from the Docker seeder stage, like ingest-archive.ts):
 *   docker run --rm --network crypto_crypto-internal --env-file .env \
 *     crypto-ops:history npx tsx scripts/ops/ingest-deribit.ts [flags]
 *
 * Flags:
 *   --datasets dvol,trades        comma list (default shown, dvol runs first)
 *   --currencies BTC,ETH          default both, validated against DERIBIT_CURRENCIES
 *   --from 2021-10-01             inclusive, default shown
 *   --to 2026-09-19               inclusive, default yesterday
 *   --cache-dir data/deribit-cache   done markers for the trades job
 *   --rate-per-sec 3              outgoing request rate to Deribit
 *   --refresh                     ignore done markers, re-fetch every day
 *   --dry-run                     print the job list only, no DB connection
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { connectDB } from '@/lib/mongodb';
import {
  DERIBIT_CURRENCIES,
  fetchDvol,
  fetchOptionTrades,
  type DeribitCurrency,
} from '@/lib/external/deribit';
import {
  aggregateOptionTrades,
  dvolUpserts,
  flowUpserts,
} from '@/lib/options-flow';
import { enumerateDays } from '@/lib/archive-ingestion';
import { bulkUpsertOptionsFlow } from '@/lib/options-flow-store';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** DVOL is published hourly. */
const DVOL_RESOLUTION_SEC = 3600;
/** A JSON heartbeat line every 25 days of a trades job, so a long run is legible. */
const HEARTBEAT_EVERY_DAYS = 25;
/**
 * A trades day is only marked done once it ended at least this long ago.
 * Marking a still-accumulating day done would freeze it at a partial trade
 * count, since nothing would ever re-fetch it.
 */
const MIN_DAY_AGE_MS = HOUR_MS;

export type DeribitDataset = 'dvol' | 'trades';

export const DATASET_KINDS: readonly DeribitDataset[] = ['dvol', 'trades'] as const;

export interface ParsedArgs {
  datasets: DeribitDataset[];
  currencies: DeribitCurrency[];
  fromMs: number;
  toMs: number;
  cacheDir: string;
  ratePerSec: number;
  refresh: boolean;
  dryRun: boolean;
}

export interface Job {
  kind: DeribitDataset;
  currency: DeribitCurrency;
  fromMs: number;
  toMs: number;
}

const DEFAULT_DATASETS = 'dvol,trades';
const DEFAULT_CACHE_DIR = 'data/deribit-cache';
/**
 * DVOL itself is published hourly back to 2021-03-24 (see deribit.ts's
 * header), earlier than this default; this is simply where the range starts
 * unless `--from` says otherwise, for both datasets alike.
 */
const DEFAULT_FROM = '2021-10-01';
const DEFAULT_RATE_PER_SEC = 3;

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
  let currenciesSpec: string | null = null;
  let fromSpec = DEFAULT_FROM;
  let toSpec: string | null = null;
  let cacheDir = DEFAULT_CACHE_DIR;
  let ratePerSec = DEFAULT_RATE_PER_SEC;
  let refresh = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--datasets':
        datasetsSpec = nextValue(argv, ++i, '--datasets');
        break;
      case '--currencies':
        currenciesSpec = nextValue(argv, ++i, '--currencies');
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
      case '--rate-per-sec': {
        const raw = nextValue(argv, ++i, '--rate-per-sec');
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`--rate-per-sec must be a positive number, got "${raw}"`);
        }
        ratePerSec = value;
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
    return name as DeribitDataset;
  });

  const currencies = parseList(currenciesSpec ?? DERIBIT_CURRENCIES.join(','), '--currencies').map(
    (name) => {
      if (!(DERIBIT_CURRENCIES as readonly string[]).includes(name)) {
        throw new Error(
          `--currencies: unknown currency "${name}", expected one of ${DERIBIT_CURRENCIES.join(', ')}`
        );
      }
      return name as DeribitCurrency;
    }
  );

  const fromMs = parseIsoDay(fromSpec, '--from');
  // Default: yesterday. Today is still accumulating, so treating it as
  // complete would be wrong for the same reason a trades day is only marked
  // done once it has fully elapsed.
  const toMs = toSpec
    ? parseIsoDay(toSpec, '--to')
    : Math.floor((now.getTime() - DAY_MS) / DAY_MS) * DAY_MS;

  if (toMs < fromMs) {
    throw new Error(`--to (${new Date(toMs).toISOString().slice(0, 10)}) is before --from`);
  }

  return { datasets, currencies, fromMs, toMs, cacheDir, ratePerSec, refresh, dryRun };
}

/**
 * Ordered job list, dvol before trades whatever order `--datasets` gave, one
 * job per currency. Dvol first simply because it is quick and independent;
 * unlike `ingest-archive.ts`'s `snapshots` job, trades does not read
 * anything dvol writes, so the order is a convenience, not a dependency.
 */
export function buildJobs(args: ParsedArgs): Job[] {
  const jobs: Job[] = [];
  const ordered: DeribitDataset[] = [
    ...args.datasets.filter((d) => d === 'dvol'),
    ...args.datasets.filter((d) => d === 'trades'),
  ];

  for (const kind of ordered) {
    for (const currency of args.currencies) {
      jobs.push({ kind, currency, fromMs: args.fromMs, toMs: args.toMs });
    }
  }

  return jobs;
}

/** Where a trades day's done marker lives. */
export function doneMarkerPath(cacheDir: string, currency: string, day: string): string {
  return join(cacheDir, 'trades', currency, `${day}.done`);
}

async function markerExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeDoneMarker(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

interface DvolJobResult {
  hours: number;
  written: number;
}

async function runDvolJob(job: Job, minGapMs: number): Promise<DvolJobResult> {
  const rows = await fetchDvol(job.currency, job.fromMs, job.toMs + DAY_MS, DVOL_RESOLUTION_SEC, {
    minGapMs,
  });
  const ops = dvolUpserts(job.currency, rows);
  const written = await bulkUpsertOptionsFlow(ops);
  return { hours: rows.length, written };
}

interface TradesJobResult {
  days: number;
  skipped: number;
  fetched: number;
  trades: number;
  hours: number;
  written: number;
}

async function runTradesJob(
  job: Job,
  cacheDir: string,
  refresh: boolean,
  minGapMs: number,
  now: number
): Promise<TradesJobResult> {
  const days = enumerateDays(job.fromMs, job.toMs);
  let skipped = 0;
  let fetched = 0;
  let trades = 0;
  let hours = 0;
  let written = 0;

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const markerPath = doneMarkerPath(cacheDir, job.currency, day);

    if (!refresh && (await markerExists(markerPath))) {
      skipped++;
    } else {
      const dayStart = Date.parse(`${day}T00:00:00Z`);
      const dayEnd = dayStart + DAY_MS - 1;
      const dayTrades = await fetchOptionTrades(job.currency, dayStart, dayEnd, { minGapMs });
      const hourRows = aggregateOptionTrades(dayTrades);
      const ops = flowUpserts(job.currency, hourRows);
      written += await bulkUpsertOptionsFlow(ops);

      fetched++;
      trades += dayTrades.length;
      hours += hourRows.length;

      if (dayStart + DAY_MS <= now - MIN_DAY_AGE_MS) {
        await writeDoneMarker(markerPath);
      }
    }

    if ((i + 1) % HEARTBEAT_EVERY_DAYS === 0) {
      console.log(
        JSON.stringify({
          kind: 'trades',
          currency: job.currency,
          heartbeat: true,
          day,
          index: i + 1,
          of: days.length,
        })
      );
    }
  }

  return { days: days.length, skipped, fetched, trades, hours, written };
}

export async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const jobs = buildJobs(args);

  if (args.dryRun) {
    for (const job of jobs) {
      console.log(JSON.stringify(job));
    }
    return 0;
  }

  await connectDB();

  const minGapMs = Math.ceil(1000 / args.ratePerSec);
  const now = Date.now();
  let hasError = false;

  for (const job of jobs) {
    const started = Date.now();
    try {
      if (job.kind === 'dvol') {
        const result = await runDvolJob(job, minGapMs);
        console.log(
          JSON.stringify({ kind: job.kind, currency: job.currency, ...result, ms: Date.now() - started })
        );
      } else {
        const result = await runTradesJob(job, args.cacheDir, args.refresh, minGapMs, now);
        console.log(
          JSON.stringify({ kind: job.kind, currency: job.currency, ...result, ms: Date.now() - started })
        );
      }
    } catch (error) {
      hasError = true;
      console.log(JSON.stringify({ kind: job.kind, currency: job.currency, error: errorMessage(error) }));
    }
  }

  return hasError ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
