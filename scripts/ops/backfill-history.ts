/**
 * Backfills durable candle and snapshot history in production so it can be
 * synced to a local Mongo for research (see scripts/ops/sync-prod-to-local.sh).
 *
 * Runs inside the seeder image; the Dockerfile's "seeder" stage copies the
 * whole repo, so no bind mount is needed. From the project root:
 *
 *   docker build --target seeder -t crypto-ops:history .
 *   docker run --rm --network crypto-internal --env-file .env \
 *     crypto-ops:history npx tsx scripts/ops/backfill-history.ts [flags]
 *
 * "crypto-internal" is the Docker network defined in docker-compose.server.yml,
 * the one crypto-mongodb is attached to; run against another compose file's
 * network if that project's names differ.
 *
 * Flags:
 *   --symbols BTCUSDT,ETHUSDT   default: SIGNAL_SYMBOLS
 *   --candles 5m:12,15m:12,1h:60,4h:96,1d:96   interval:months list (default shown)
 *   --snapshots 1h:60,4h:96,1d:96               interval:months list (default shown)
 *   --skip-candles      skip every candle job
 *   --skip-snapshots    skip every snapshot job
 *   --unset-5m-ttl      clear expiresAt from 5m candles written before 5m was durable
 *   --dry-run           print the job list as JSON lines and exit, no DB connection
 */
import { connectDB } from '@/lib/mongodb';
import { backfillCandles, getCandleRange } from '@/lib/candle-ingestion';
import {
  fetchFundingHistory,
  loadFearGreedLookup,
  backfillSnapshotRange,
  MAX_FEAR_GREED_CARRY_DAYS,
  type FundingEvent,
} from '@/lib/snapshot-backfill';
import { Candle, VALID_INTERVALS } from '@/lib/models/candle';
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
  unsetFiveMinuteTtl: boolean;
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

/** Pure argv parser: no I/O, so it is unit tested directly. */
export function parseArgs(argv: string[]): ParsedArgs {
  let symbolsSpec: string | null = null;
  let candlesSpec = DEFAULT_CANDLES;
  let snapshotsSpec = DEFAULT_SNAPSHOTS;
  let skipCandles = false;
  let skipSnapshots = false;
  let unsetFiveMinuteTtl = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--symbols':
        symbolsSpec = argv[++i];
        break;
      case '--candles':
        candlesSpec = argv[++i];
        break;
      case '--snapshots':
        snapshotsSpec = argv[++i];
        break;
      case '--skip-candles':
        skipCandles = true;
        break;
      case '--skip-snapshots':
        skipSnapshots = true;
        break;
      case '--unset-5m-ttl':
        unsetFiveMinuteTtl = true;
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
    unsetFiveMinuteTtl,
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

  if (args.unsetFiveMinuteTtl) {
    const result = await Candle.updateMany(
      { interval: '5m', expiresAt: { $exists: true } },
      { $unset: { expiresAt: 1 } }
    );
    console.log(JSON.stringify({ kind: 'unset-5m-ttl', modifiedCount: result.modifiedCount }));
  }

  const snapshotJobs = jobs.filter((j) => j.kind === 'snapshots');
  const globalMaxMonths = snapshotJobs.reduce((max, j) => Math.max(max, j.months), 0);
  const fearGreedAt =
    snapshotJobs.length > 0
      ? await loadFearGreedLookup(globalMaxMonths * 31 + MAX_FEAR_GREED_CARRY_DAYS)
      : null;

  const fundingBySymbol = new Map<string, FundingEvent[]>();

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
      console.error(`Failed to fetch funding history for ${symbol}:`, errorMessage(error));
    }

    fundingBySymbol.set(symbol, events);
    return events;
  }

  let hasError = false;

  for (const job of jobs) {
    const started = Date.now();
    try {
      if (job.kind === 'candles') {
        const { inserted } = await backfillCandles(job.symbol, job.interval, job.months);
        const range = await getCandleRange(job.symbol, job.interval);
        console.log(JSON.stringify({
          kind: 'candles',
          symbol: job.symbol,
          interval: job.interval,
          months: job.months,
          inserted,
          count: range.count,
          from: range.oldest,
          to: range.newest,
          ms: Date.now() - started,
        }));
      } else {
        const fundingEvents = await fundingEventsFor(job.symbol);
        const endTime = Date.now();
        const startTime = endTime - job.months * 30 * DAY_MS;

        const result = await backfillSnapshotRange({
          symbol: job.symbol,
          interval: job.interval,
          startTime,
          endTime,
          fundingEvents,
          fearGreedAt: fearGreedAt!,
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

      await sleep(PAIR_DELAY_MS);
    } catch (error) {
      hasError = true;
      console.log(JSON.stringify({
        kind: job.kind,
        symbol: job.symbol,
        interval: job.interval,
        months: job.months,
        error: errorMessage(error),
      }));
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
