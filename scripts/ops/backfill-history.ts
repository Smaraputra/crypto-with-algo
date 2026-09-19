/**
 * Backfills durable candle and snapshot history in production so it can be
 * synced to a local Mongo for research (see scripts/ops/sync-prod-to-local.sh).
 *
 * Runs inside the seeder image; the Dockerfile's "seeder" stage copies the
 * whole repo, so no bind mount is needed. From the project root:
 *
 *   docker build --target seeder -t crypto-ops:history .
 *   docker run --rm --network crypto_crypto-internal --env-file .env \
 *     crypto-ops:history npx tsx scripts/ops/backfill-history.ts [flags]
 *
 * "crypto_crypto-internal" is the network docker compose actually creates for
 * docker-compose.server.yml's "crypto-internal" network: compose prefixes
 * network names with the project name, and .github/workflows/deploy.yml runs
 * `docker compose -f docker-compose.server.yml up -d` from /opt/sites/crypto
 * on the VPS, so the project name defaults to "crypto". Check with
 * `docker network ls` if that directory name ever changes.
 *
 * Recommended runbook, in order:
 *   1. Deploy the app from this branch. Both --unset-5m-ttl and
 *      --drop-snapshot-ttl depend on the schema this branch ships; see the
 *      WARNING below on why they must not run against an old container.
 *   2. Run the two migration flags alone, nothing else:
 *      --unset-5m-ttl --drop-snapshot-ttl --skip-candles --skip-snapshots
 *      Verify their JSON lines before continuing.
 *   3. Run the candle pass with --refill (see below).
 *   4. Run the snapshot pass.
 *
 * WARNING: run --unset-5m-ttl and --drop-snapshot-ttl only after the app has
 * been redeployed from this branch, never before or during. mongoose.connect
 * (src/lib/mongodb.ts) leaves autoIndex on, so an app container still running
 * the previous schema silently recreates the createdAt_1 TTL index this drops
 * the next time it writes a HistoricalSnapshot, and old code keeps setting
 * expiresAt on the 5m candles it writes. This script also prints a one-line
 * warning at runtime when either flag is passed, as a last-resort reminder.
 *
 * Flags:
 *   --symbols BTCUSDT,ETHUSDT   default: SIGNAL_SYMBOLS
 *   --candles 5m:12,15m:12,1h:60,4h:96,1d:96   interval:months list (default shown)
 *   --snapshots 1h:60,4h:96,1d:96               interval:months list (default shown)
 *   --skip-candles      skip every candle job
 *   --skip-snapshots    skip every snapshot job
 *   --refill            re-fetch every stored bar instead of only the gaps
 *                       around them, for every candle job. Run this for the
 *                       first production candle pass after deploying the
 *                       candle finalization fix (a separate branch): bars
 *                       synced before that fix can hold partial values, and a
 *                       refill is the only way the gap strategy repairs
 *                       already-stored rows. Costs a full re-fetch every time:
 *                       a refill of 5m over 12 months is about 105 requests
 *                       per symbol.
 *   --unset-5m-ttl      clear expiresAt from 5m candles written before 5m was durable
 *   --drop-snapshot-ttl drop the legacy one-year TTL index on HistoricalSnapshot.createdAt
 *   --dry-run           print the job list as JSON lines and exit, no DB connection
 *
 * Each candle job's log line reports requestedFrom (the raw window-start
 * instant it asked Binance for) next to alignedRequestedFrom (the first bar
 * open time at or after requestedFrom: Math.ceil(requestedFrom / intervalMs)
 * * intervalMs, intervalToMs from src/lib/intervals.ts) and the stored
 * from/to, with a complete flag that is true only when
 * from <= alignedRequestedFrom. Binance returns bars aligned to the interval
 * boundary, so the first stored bar is always at or after requestedFrom
 * itself, essentially never exactly on it; comparing against the raw instant
 * made every production candle job report complete: false regardless of how
 * much history was actually fetched. fetchKlinesRange (src/lib/binance.ts)
 * silently stops at a 120-second deadline and returns whatever it fetched so
 * far, and backfillCandles reports that as success; the default 5m:12 spec is
 * about 104 pages per symbol, close enough to that budget that one pass can
 * come back incomplete. A false complete means that job needs a second pass;
 * re-running is safe, since backfillCandles without --refill only fetches the
 * gaps around what is already stored, so it resumes from the newest (and
 * oldest) bar already on disk rather than starting over.
 */
import { connectDB } from '@/lib/mongodb';
import { intervalToMs } from '@/lib/intervals';
import { backfillCandles, getCandleRange } from '@/lib/candle-ingestion';
import {
  fetchFundingHistory,
  loadFearGreedLookup,
  backfillSnapshotRange,
  MAX_FEAR_GREED_CARRY_DAYS,
  type FundingEvent,
} from '@/lib/snapshot-backfill';
import { Candle, VALID_INTERVALS } from '@/lib/models/candle';
import { HistoricalSnapshot } from '@/lib/models/historical-snapshot';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

const DAY_MS = 24 * 60 * 60 * 1000;
const FUNDING_LOOKBACK_MS = 8 * 60 * 60 * 1000;
/** One second between pairs, matching the admin backfill routes' pacing. */
const PAIR_DELAY_MS = 1000;

export interface IntervalMonths {
  interval: string;
  months: number;
}

export interface ParsedArgs {
  symbols: string[];
  candles: IntervalMonths[];
  snapshots: IntervalMonths[];
  skipCandles: boolean;
  skipSnapshots: boolean;
  refill: boolean;
  unsetFiveMinuteTtl: boolean;
  dropSnapshotTtl: boolean;
  dryRun: boolean;
}

export type JobKind = 'candles' | 'snapshots';

export interface Job {
  kind: JobKind;
  symbol: string;
  interval: string;
  months: number;
}

const DEFAULT_CANDLES = '5m:12,15m:12,1h:60,4h:96,1d:96';
const DEFAULT_SNAPSHOTS = '1h:60,4h:96,1d:96';

function parseIntervalMonthsSpec(spec: string, flag: string): IntervalMonths[] {
  return spec.split(',').map((piece) => {
    const trimmed = piece.trim();
    const [interval, monthsRaw] = trimmed.split(':');

    if (!interval || !(VALID_INTERVALS as readonly string[]).includes(interval)) {
      throw new Error(`${flag}: unknown interval "${interval}" in "${trimmed}"`);
    }

    if (!monthsRaw || !/^-?\d+$/.test(monthsRaw)) {
      throw new Error(`${flag}: months must be an integer in "${trimmed}"`);
    }

    const months = Number(monthsRaw);
    if (months < 1) {
      throw new Error(`${flag}: months must be at least 1 in "${trimmed}"`);
    }

    return { interval, months };
  });
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
export function parseArgs(argv: string[]): ParsedArgs {
  let symbolsSpec: string | null = null;
  let candlesSpec = DEFAULT_CANDLES;
  let snapshotsSpec = DEFAULT_SNAPSHOTS;
  let skipCandles = false;
  let skipSnapshots = false;
  let refill = false;
  let unsetFiveMinuteTtl = false;
  let dropSnapshotTtl = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--symbols':
        symbolsSpec = nextValue(argv, ++i, '--symbols');
        break;
      case '--candles':
        candlesSpec = nextValue(argv, ++i, '--candles');
        break;
      case '--snapshots':
        snapshotsSpec = nextValue(argv, ++i, '--snapshots');
        break;
      case '--skip-candles':
        skipCandles = true;
        break;
      case '--skip-snapshots':
        skipSnapshots = true;
        break;
      case '--refill':
        refill = true;
        break;
      case '--unset-5m-ttl':
        unsetFiveMinuteTtl = true;
        break;
      case '--drop-snapshot-ttl':
        dropSnapshotTtl = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        throw new Error(`Unknown flag "${flag}"`);
    }
  }

  const symbols = symbolsSpec
    ? symbolsSpec.split(',').map((s) => s.trim()).filter(Boolean)
    : [...SIGNAL_SYMBOLS];

  return {
    symbols,
    candles: parseIntervalMonthsSpec(candlesSpec, '--candles'),
    snapshots: parseIntervalMonthsSpec(snapshotsSpec, '--snapshots'),
    skipCandles,
    skipSnapshots,
    refill,
    unsetFiveMinuteTtl,
    dropSnapshotTtl,
    dryRun,
  };
}

/** Ordered job list: every candle job, then every snapshot job. */
export function buildJobs(args: ParsedArgs): Job[] {
  const jobs: Job[] = [];

  if (!args.skipCandles) {
    for (const symbol of args.symbols) {
      for (const spec of args.candles) {
        jobs.push({ kind: 'candles', symbol, interval: spec.interval, months: spec.months });
      }
    }
  }

  if (!args.skipSnapshots) {
    for (const symbol of args.symbols) {
      for (const spec of args.snapshots) {
        jobs.push({ kind: 'snapshots', symbol, interval: spec.interval, months: spec.months });
      }
    }
  }

  return jobs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
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

  let hasError = false;

  if (args.unsetFiveMinuteTtl || args.dropSnapshotTtl) {
    console.error(
      'WARNING: --unset-5m-ttl and --drop-snapshot-ttl must run only after the ' +
      'app has been redeployed from this branch. An old app container still on ' +
      'the previous schema can recreate the dropped TTL index (autoIndex is on) ' +
      'and keeps writing expiresAt onto live 5m candles.'
    );
  }

  if (args.unsetFiveMinuteTtl) {
    try {
      const result = await Candle.updateMany(
        { interval: '5m', expiresAt: { $exists: true } },
        { $unset: { expiresAt: 1 } }
      );
      console.log(JSON.stringify({ kind: 'unset-5m-ttl', modifiedCount: result.modifiedCount }));
    } catch (error) {
      hasError = true;
      console.log(JSON.stringify({ kind: 'migration', action: 'unset-5m-ttl', error: errorMessage(error) }));
    }
  }

  if (args.dropSnapshotTtl) {
    try {
      const indexes = await HistoricalSnapshot.collection.indexes();
      const ttlIndex = indexes.find(
        (idx) =>
          idx.expireAfterSeconds !== undefined &&
          idx.key.createdAt === 1 &&
          Object.keys(idx.key).length === 1
      );

      if (ttlIndex?.name) {
        await HistoricalSnapshot.collection.dropIndex(ttlIndex.name);
      }

      console.log(JSON.stringify({
        kind: 'migration',
        action: 'drop-snapshot-ttl',
        dropped: ttlIndex?.name ?? null,
      }));
    } catch (error) {
      hasError = true;
      console.log(JSON.stringify({ kind: 'migration', action: 'drop-snapshot-ttl', error: errorMessage(error) }));
    }
  }

  const snapshotJobs = jobs.filter((j) => j.kind === 'snapshots');
  const globalMaxMonths = snapshotJobs.reduce((max, j) => Math.max(max, j.months), 0);
  const fearGreedAt =
    snapshotJobs.length > 0
      ? await loadFearGreedLookup(globalMaxMonths * 31 + MAX_FEAR_GREED_CARRY_DAYS)
      : null;

  const fundingBySymbol = new Map<string, FundingEvent[]>();

  // A funding failure does not stop that symbol's snapshot jobs: they still
  // run without funding coverage, and a later re-run's merge upsert can add
  // it. It does mark the run as failed, so the operator notices and re-runs.
  async function fundingEventsFor(symbol: string): Promise<FundingEvent[]> {
    const cached = fundingBySymbol.get(symbol);
    if (cached) return cached;

    const symbolMaxMonths = snapshotJobs
      .filter((j) => j.symbol === symbol)
      .reduce((max, j) => Math.max(max, j.months), 0);
    const end = Date.now();
    const start = end - symbolMaxMonths * 30 * DAY_MS;

    let events: FundingEvent[] = [];
    try {
      events = await fetchFundingHistory(symbol, start - FUNDING_LOOKBACK_MS, end);
    } catch (error) {
      hasError = true;
      console.log(JSON.stringify({ kind: 'funding', symbol, error: errorMessage(error) }));
    }

    fundingBySymbol.set(symbol, events);
    return events;
  }

  for (const job of jobs) {
    const started = Date.now();
    try {
      if (job.kind === 'candles') {
        const requestedFrom = started - job.months * 30 * DAY_MS;
        const intervalMs = intervalToMs(job.interval);
        const alignedRequestedFrom = Math.ceil(requestedFrom / intervalMs) * intervalMs;
        const { inserted } = args.refill
          ? await backfillCandles(job.symbol, job.interval, job.months, { refill: true })
          : await backfillCandles(job.symbol, job.interval, job.months);
        const range = await getCandleRange(job.symbol, job.interval);
        const complete = range.oldest !== null && range.oldest <= alignedRequestedFrom;
        console.log(JSON.stringify({
          kind: 'candles',
          symbol: job.symbol,
          interval: job.interval,
          months: job.months,
          refill: args.refill,
          inserted,
          count: range.count,
          requestedFrom,
          alignedRequestedFrom,
          from: range.oldest,
          to: range.newest,
          complete,
          ms: Date.now() - started,
        }));
      } else {
        // fearGreedAt is set whenever a snapshot job exists (see above); this
        // narrows it instead of asserting it, so a future refactor that
        // breaks that invariant fails loudly rather than passing null through.
        if (!fearGreedAt) {
          throw new Error('Internal error: fearGreedAt lookup was not initialized for a snapshot job');
        }

        const fundingEvents = await fundingEventsFor(job.symbol);
        const endTime = Date.now();
        const startTime = endTime - job.months * 30 * DAY_MS;

        const result = await backfillSnapshotRange({
          symbol: job.symbol,
          interval: job.interval,
          startTime,
          endTime,
          fundingEvents,
          fearGreedAt,
        });

        console.log(JSON.stringify({
          kind: 'snapshots',
          symbol: job.symbol,
          interval: job.interval,
          months: job.months,
          snapshots: result.snapshots,
          coverage: result.coverage,
          ms: Date.now() - started,
        }));
      }
    } catch (error) {
      hasError = true;
      console.log(JSON.stringify({
        kind: job.kind,
        symbol: job.symbol,
        interval: job.interval,
        months: job.months,
        error: errorMessage(error),
      }));
    } finally {
      // Pause between pairs even after a failure, so a run of rejections
      // (e.g. a Binance 418) does not hammer the remaining jobs with no backoff.
      await sleep(PAIR_DELAY_MS);
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
