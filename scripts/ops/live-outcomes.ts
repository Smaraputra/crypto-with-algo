/**
 * Reads the live signal outcome record: per-tier expectancy computed by
 * getLiveTierExpectancy (src/lib/signals/outcome-analytics.ts) from resolved
 * SignalOutcome documents, plus status counts and resolved-date coverage,
 * per trading style. The outcome resolver (POST /api/cron/resolve-outcomes,
 * every 15 minutes) is the only writer of SignalOutcome; this script is the
 * first reader of getLiveTierExpectancy.
 *
 * What the numbers mean: expectancy is the forward return from a signal's
 * candle close to the close of the horizon bar (OUTCOME_HORIZON_BARS) later,
 * at the style's primary interval (getIntervalForStyle). buy/strong_buy and
 * neutral (informational) tiers read that return as-is; sell/strong_sell
 * invert it, since a sell tier's prediction wins when price falls (the
 * same directional-return definition the backtest engine uses).
 * netExpectancyPercent subtracts a fixed round-trip cost estimate (--cost
 * below) from grossExpectancyPercent; win rate, MFE, and MAE are reported
 * before cost, from the long perspective, regardless of tier.
 *
 * What the numbers are NOT: there is no stop loss, no take profit, and no
 * fill simulation here. This is a close-to-close forward return over a
 * fixed horizon, not a backtest trade, and the cost subtracted is a fixed
 * estimate (two taker legs plus slippage at the style's interval), not a
 * measured fill cost.
 *
 * Outcomes created before the 2026-09-17 finalization deploy do not exist:
 * the SignalOutcome model shipped with that deploy, so there is no pending
 * or resolved record for anything scored earlier.
 *
 * Runs inside the seeder image against production. From the deployed
 * checkout (/opt/sites/crypto on the VPS):
 *
 *   docker build --target seeder -t crypto-ops:history .
 *   docker run --rm --network crypto_crypto-internal --env-file .env \
 *     crypto-ops:history npx tsx scripts/ops/live-outcomes.ts --style day_trading
 *
 * "crypto_crypto-internal" matches backfill-history.ts's own note: compose
 * prefixes docker-compose.server.yml's "crypto-internal" network with the
 * project name, which defaults to the /opt/sites/crypto directory name.
 *
 * Runs locally against a synced database (see scripts/ops/sync-prod-to-local.sh):
 *
 *   npx tsx scripts/ops/live-outcomes.ts --style day_trading \
 *     --mongo-uri mongodb://localhost:27017/cryptowithalgo
 *
 * --mongo-uri must take effect before connectDB() is called. connectDB
 * (src/lib/mongodb.ts) reads process.env.MONGODB_URI inside its function
 * body at call time, not at module import time, so main() sets the override
 * before calling connectDB() and that is sufficient with connectDB's current
 * implementation (a static top-level import of connectDB does not read the
 * variable early). A deferred `await import('@/lib/mongodb')` inside main()
 * was considered instead (import it only after the override is set, so nothing
 * about the read timing matters even if connectDB changes), but is not used:
 * under this project's tsx/CJS runtime, dynamically importing a CommonJS
 * module does not reliably expose its named exports (verified: the resulting
 * namespace's .connectDB is undefined; only .default.connectDB is the real
 * function), so that pattern would silently break the very thing it defends.
 *
 * Flags:
 *   --style <scalping|day_trading|swing_trading|position_trading|all>  default: all
 *   --source <composite|llm|all>  default: composite. llm rows are the panel
 *                       factor's own forward-only calls (LlmCall), recorded
 *                       as separate SignalOutcome documents from the
 *                       composite score's; composite excludes them (and
 *                       legacy rows with no source, which predate the
 *                       field), llm shows only them, all reports both blocks
 *                       per style, composite then llm
 *   --symbol <SYMBOL>   optional, filters every section (status counts,
 *                       resolved range, tiers) to that symbol
 *   --since <ISO date>  optional; filters only the tier expectancy section
 *                       on resolvedAt (passed straight through to
 *                       getLiveTierExpectancy). Status counts and the
 *                       resolved date range always cover all time, so they
 *                       still show the resolver's full coverage regardless
 *                       of the window --since narrows the tiers to
 *   --cost <percent>    optional round-trip cost in percent, subtracted from
 *                       every tier's gross expectancy. Default per style:
 *                       the study's taker-in, taker-out round trip with
 *                       slippage on both legs for the style's primary
 *                       interval (0.20% scalping/5m, 0.16% day_trading/1h,
 *                       0.14% swing_trading/4h and position_trading/1d,
 *                       see defaultCostPercent). --cost 0 gives gross figures
 *   --json              one JSON line per style instead of the table
 *   --mongo-uri <uri>   override MONGODB_URI before connecting
 */
import type { TradingStyle } from '@/lib/models/signal-template';
import type { SignalTier } from '@/types/signal';
import {
  SignalOutcome,
  sourceMatch,
  type SignalOutcomeSource,
  type SignalOutcomeStatus,
} from '@/lib/models/signal-outcome';
import { getLiveTierExpectancy } from '@/lib/signals/outcome-analytics';
import { OUTCOME_HORIZON_BARS } from '@/lib/signals/outcome-horizons';
import { getIntervalForStyle } from '@/lib/optimization/top-symbols';
import { BINANCE_FUTURES_TAKER_FEE, STUDY_SLIPPAGE_BPS } from '@/lib/backtest/cost-model';
import { connectDB } from '@/lib/mongodb';

export type StyleFilter = TradingStyle | 'all';
export type SourceFilter = SignalOutcomeSource | 'all';
const SOURCE_VALUES: SourceFilter[] = ['composite', 'llm', 'all'];

export interface ParsedArgs {
  style: StyleFilter;
  source: SourceFilter;
  symbol: string | null;
  since: Date | null;
  cost: number | null;
  json: boolean;
  mongoUri: string | null;
}

export interface RunLiveOutcomesArgs {
  style: StyleFilter;
  source: SourceFilter;
  symbol: string | null;
  since: Date | null;
  cost: number | null;
}

export interface StatusCounts {
  pending: number;
  resolved: number;
  unresolvable: number;
}

export interface ResolvedRange {
  from: string | null;
  to: string | null;
}

export interface LiveTierRow {
  tier: SignalTier;
  count: number;
  grossExpectancyPercent: number;
  netExpectancyPercent: number;
  winRate: number;
  avgMfePercent: number;
  avgMaePercent: number;
}

export interface StyleOutcomes {
  style: TradingStyle;
  source: SignalOutcomeSource;
  interval: string;
  horizonBars: number;
  costPercent: number;
  statusCounts: StatusCounts;
  resolvedRange: ResolvedRange;
  tiers: LiveTierRow[];
}

export interface LiveOutcomesReport {
  generatedAt: string;
  symbol: string | null;
  since: string | null;
  styles: StyleOutcomes[];
}

const TRADING_STYLE_ORDER: TradingStyle[] = [
  'scalping',
  'day_trading',
  'swing_trading',
  'position_trading',
];

const STYLE_VALUES: StyleFilter[] = [...TRADING_STYLE_ORDER, 'all'];

/**
 * Default round-trip cost estimate for a style, in percent: two taker legs
 * (entry and exit) plus slippage on both legs, at the style's primary
 * interval. Mirrors studyCostConfig's taker fee and STUDY_SLIPPAGE_BPS,
 * the same cost model the backtest track measured strategies against.
 */
export function defaultCostPercent(style: TradingStyle): number {
  const interval = getIntervalForStyle(style);
  const slippageBps = STUDY_SLIPPAGE_BPS[interval];
  if (slippageBps === undefined) {
    throw new Error(`No slippage budget configured for interval: ${interval}`);
  }
  return 2 * BINANCE_FUTURES_TAKER_FEE * 100 + (2 * slippageBps) / 100;
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
  let style: StyleFilter = 'all';
  let source: SourceFilter = 'composite';
  let symbol: string | null = null;
  let since: Date | null = null;
  let cost: number | null = null;
  let json = false;
  let mongoUri: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--style': {
        const value = nextValue(argv, ++i, '--style');
        if (!STYLE_VALUES.includes(value as StyleFilter)) {
          throw new Error(
            `--style: unknown value "${value}" (expected one of ${STYLE_VALUES.join(', ')})`
          );
        }
        style = value as StyleFilter;
        break;
      }
      case '--source': {
        const value = nextValue(argv, ++i, '--source');
        if (!SOURCE_VALUES.includes(value as SourceFilter)) {
          throw new Error(
            `--source: unknown value "${value}" (expected one of ${SOURCE_VALUES.join(', ')})`
          );
        }
        source = value as SourceFilter;
        break;
      }
      case '--symbol':
        symbol = nextValue(argv, ++i, '--symbol');
        break;
      case '--since': {
        const value = nextValue(argv, ++i, '--since');
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error(`--since: invalid date "${value}"`);
        }
        since = parsed;
        break;
      }
      case '--cost': {
        const value = nextValue(argv, ++i, '--cost');
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          throw new Error(`--cost: invalid number "${value}"`);
        }
        cost = parsed;
        break;
      }
      case '--json':
        json = true;
        break;
      case '--mongo-uri':
        mongoUri = nextValue(argv, ++i, '--mongo-uri');
        break;
      default:
        throw new Error(`Unknown flag "${flag}"`);
    }
  }

  return { style, source, symbol, since, cost, json, mongoUri };
}

interface StatusCountRow {
  _id: SignalOutcomeStatus;
  count: number;
}

interface ResolvedRangeRow {
  _id: null;
  earliest: Date;
  latest: Date;
}

async function computeStyleOutcomes(
  style: TradingStyle,
  source: SignalOutcomeSource,
  args: RunLiveOutcomesArgs
): Promise<StyleOutcomes> {
  const interval = getIntervalForStyle(style);
  const horizonBars = OUTCOME_HORIZON_BARS[style];
  const costPercent = args.cost ?? defaultCostPercent(style);

  const baseMatch: Record<string, unknown> = { tradingStyle: style, ...sourceMatch(source) };
  if (args.symbol) baseMatch.symbol = args.symbol;

  const statusRows: StatusCountRow[] = await SignalOutcome.aggregate([
    { $match: baseMatch },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const statusCounts: StatusCounts = { pending: 0, resolved: 0, unresolvable: 0 };
  for (const row of statusRows) {
    statusCounts[row._id] = row.count;
  }

  const rangeRows: ResolvedRangeRow[] = await SignalOutcome.aggregate([
    { $match: { ...baseMatch, status: 'resolved' } },
    { $group: { _id: null, earliest: { $min: '$resolvedAt' }, latest: { $max: '$resolvedAt' } } },
  ]);
  const resolvedRange: ResolvedRange =
    rangeRows.length > 0
      ? {
          from: rangeRows[0].earliest ? new Date(rangeRows[0].earliest).toISOString() : null,
          to: rangeRows[0].latest ? new Date(rangeRows[0].latest).toISOString() : null,
        }
      : { from: null, to: null };

  // costPercentRoundTrip is intentionally left at getLiveTierExpectancy's
  // own default (0) here: it returns the gross figure, and cost is
  // subtracted exactly once below to produce the net figure.
  const rawTiers = await getLiveTierExpectancy({
    tradingStyle: style,
    symbol: args.symbol ?? undefined,
    since: args.since ?? undefined,
    source,
  });

  const tiers: LiveTierRow[] = rawTiers.map((tier) => ({
    tier: tier.tier,
    count: tier.count,
    grossExpectancyPercent: tier.expectancyPercent,
    netExpectancyPercent: tier.expectancyPercent - costPercent,
    winRate: tier.winRate,
    avgMfePercent: tier.avgMfePercent,
    avgMaePercent: tier.avgMaePercent,
  }));

  return { style, source, interval, horizonBars, costPercent, statusCounts, resolvedRange, tiers };
}

/** Does the read: no printing, no process I/O, so it is unit tested directly
 * against mongodb-memory-server without touching stdout or argv. */
export async function runLiveOutcomes(args: RunLiveOutcomesArgs): Promise<LiveOutcomesReport> {
  const styles = args.style === 'all' ? TRADING_STYLE_ORDER : [args.style];
  const sources: SignalOutcomeSource[] = args.source === 'all' ? ['composite', 'llm'] : [args.source];

  const styleOutcomes: StyleOutcomes[] = [];
  for (const style of styles) {
    for (const source of sources) {
      styleOutcomes.push(await computeStyleOutcomes(style, source, args));
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    symbol: args.symbol,
    since: args.since ? args.since.toISOString() : null,
    styles: styleOutcomes,
  };
}

const NOTE_LINE =
  'note: net subtracts a fixed round-trip cost estimate from a close-to-close forward return; it is not a fill simulation';

function formatHeader(style: StyleOutcomes): string {
  const from = style.resolvedRange.from ?? 'n/a';
  const to = style.resolvedRange.to ?? 'n/a';
  return (
    `style=${style.style} source=${style.source} interval=${style.interval} horizon=${style.horizonBars} bars ` +
    `cost=${style.costPercent.toFixed(4)}% pending=${style.statusCounts.pending} ` +
    `resolved=${style.statusCounts.resolved} unresolvable=${style.statusCounts.unresolvable} ` +
    `resolved ${from}..${to}`
  );
}

function formatTierRow(tier: LiveTierRow): string {
  return (
    `  ${tier.tier}: count=${tier.count} gross=${tier.grossExpectancyPercent.toFixed(4)}% ` +
    `net=${tier.netExpectancyPercent.toFixed(4)}% winRate=${tier.winRate.toFixed(4)} ` +
    `mfe=${tier.avgMfePercent.toFixed(4)}% mae=${tier.avgMaePercent.toFixed(4)}%`
  );
}

/** Renders the report either as JSON lines or as the plain table; pure
 * string building, so it is unit tested directly without mocking stdout. */
export function formatReport(report: LiveOutcomesReport, json: boolean): string {
  if (json) {
    return report.styles.map((style) => JSON.stringify(style)).join('\n');
  }

  const lines: string[] = [];
  report.styles.forEach((style, index) => {
    if (index > 0) lines.push('');
    lines.push(formatHeader(style));
    for (const tier of style.tiers) {
      lines.push(formatTierRow(tier));
    }
  });
  lines.push(NOTE_LINE);
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.mongoUri) {
      process.env.MONGODB_URI = args.mongoUri;
    }

    await connectDB();

    const report = await runLiveOutcomes({
      style: args.style,
      source: args.source,
      symbol: args.symbol,
      since: args.since,
      cost: args.cost,
    });

    console.log(formatReport(report, args.json));
    process.exit(0);
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
