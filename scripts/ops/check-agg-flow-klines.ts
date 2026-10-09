/**
 * Full-history accuracy check of `archiveflowbars` for the QH-FLOW research phase
 * (header of scripts/research/qh-flow.ts). The locked extractor validation
 * (`validate-agg-flow.ts`) compares ONE day against the live recorder. This
 * compares EVERY bucket of the requested months against Binance's own perp 5m
 * klines (`PerpCandle`, series `klines`, interval `5m`).
 *
 * Why klines are an independent source: Binance builds its klines from the same
 * trades the aggTrades archive carries, but through its own pipeline, and they
 * were ingested by a different script from different archive files. If the
 * aggTrades fold drops, duplicates or misplaces trades, the bucket totals stop
 * matching the kline totals.
 *
 * Field mapping (archive bucket -> kline):
 *   buyBase + sellBase   -> volume
 *   buyQuote + sellQuote -> quoteVolume
 *   buyBase              -> takerBuyVolume (optional on the kline; a few rows lack it)
 *   trades               -> trades (integers, exact)
 *   bucketStart          -> timestamp
 *
 * Also checked on the archive side alone (`checkInvariants`): the size-class
 * quote sums equal the total on each side (relative 1e-9, absolute 1e-9 when the
 * total is 0), the first-10-seconds quote never exceeds the total, and every
 * numeric field is finite and non-negative.
 *
 * It reads only volumes and counts, never a price, return or factor. READ-ONLY:
 * nothing is written to Mongo. Memory: one symbol-month is queried and joined at
 * a time, never a whole symbol.
 *
 * PASS RULE (declared before any result exists, do not change it):
 *   - coverage: missingInArchive === 0 and missingInKlines === 0;
 *   - agreement: at least 99.9% of compared buckets have relative error <= 1e-6
 *     on volume, on quoteVolume and on takerBuy (takerBuy over buckets where it
 *     is available), and trades equal exactly in at least 99.9%;
 *   - invariants: invariantFailures === 0.
 *   A symbol passes when all three hold; the run passes when every symbol passes.
 *
 * Definitions: relative error is |a - b| / max(|b|, 1e-12) with b the kline
 * value. missingInArchive counts kline buckets with trades > 0 and no archive
 * bucket. missingInKlines counts archive buckets with no kline row.
 * zeroTradeKlines counts kline buckets with trades === 0 (expected to have no
 * archive bucket). A symbol with no compared bucket, or whose every compared
 * bucket lacks takerBuyVolume, fails agreement.
 *
 * LOCKBOX: nothing from 2026-07 onward is read. Any --to at or after it is
 * refused before connecting.
 *
 * Usage:
 *   docker run --rm --network crypto_crypto-internal --env-file /opt/sites/crypto/.env crypto-ops:<tag> npx --yes tsx scripts/ops/check-agg-flow-klines.ts [flags]
 *
 * Flags:
 *   --symbols BTCUSDT,ETHUSDT   default SIGNAL_SYMBOLS
 *   --from 2023-01              first month, inclusive (default shown)
 *   --to 2026-06                last month, inclusive (default shown, the maximum)
 *   --mongo-uri <uri>           overrides MONGODB_URI
 *
 * Output: one JSON line per symbol (the accumulator result plus `pass`), then
 * { summary: true, symbols, pass, failedSymbols }. Exit 0 on pass, 2 on fail,
 * 1 on error (message on stderr).
 */
import { connectDB } from '@/lib/mongodb';
import { ArchiveFlowBar } from '@/lib/models/archive-flow-bar';
import { PerpCandle } from '@/lib/models/perp-candle';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

export const DEFAULT_FROM = '2023-01';
export const DEFAULT_TO = '2026-06';
const LOCKBOX_MONTH = '2026-07';
const REL_FLOOR = 1e-12;
const INVARIANT_TOL = 1e-9;
const PASS_FRACTION_NUM = 999;
const PASS_FRACTION_DEN = 1000;
const WORST_N = 5;

export interface ArchiveBar {
  bucketStart: number;
  trades: number;
  buyBase: number;
  sellBase: number;
  buyQuote: number;
  sellQuote: number;
  buyQuoteSmall: number;
  buyQuoteMedium: number;
  buyQuoteLarge: number;
  sellQuoteSmall: number;
  sellQuoteMedium: number;
  sellQuoteLarge: number;
  buyQuoteOpen10s: number;
  sellQuoteOpen10s: number;
}

export interface KlineBar {
  timestamp: number;
  volume: number;
  quoteVolume: number;
  trades: number;
  takerBuyVolume?: number;
}

export interface BucketComparison {
  volume: number;
  quoteVolume: number;
  /** null when the kline lacks takerBuyVolume. */
  takerBuy: number | null;
  tradesMatch: boolean;
}

function relErr(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(b), REL_FLOOR);
}

export function compareBucket(archive: ArchiveBar, kline: KlineBar): BucketComparison {
  return {
    volume: relErr(archive.buyBase + archive.sellBase, kline.volume),
    quoteVolume: relErr(archive.buyQuote + archive.sellQuote, kline.quoteVolume),
    takerBuy: typeof kline.takerBuyVolume === 'number' ? relErr(archive.buyBase, kline.takerBuyVolume) : null,
    tradesMatch: archive.trades === kline.trades,
  };
}

const NUMERIC_FIELDS = [
  'trades',
  'buyBase',
  'sellBase',
  'buyQuote',
  'sellQuote',
  'buyQuoteSmall',
  'buyQuoteMedium',
  'buyQuoteLarge',
  'sellQuoteSmall',
  'sellQuoteMedium',
  'sellQuoteLarge',
  'buyQuoteOpen10s',
  'sellQuoteOpen10s',
] as const;

function classSumOff(total: number, parts: number): boolean {
  const tol = total === 0 ? INVARIANT_TOL : INVARIANT_TOL * Math.abs(total);
  return !(Math.abs(parts - total) <= tol);
}

/** Returns the failed invariants as short strings; empty when the bucket is consistent. */
export function checkInvariants(a: ArchiveBar): string[] {
  const failures: string[] = [];
  for (const f of NUMERIC_FIELDS) {
    const v = a[f];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) failures.push(`${f} not finite and non-negative`);
  }
  if (classSumOff(a.buyQuote, a.buyQuoteSmall + a.buyQuoteMedium + a.buyQuoteLarge)) failures.push('buy class sum != buyQuote');
  if (classSumOff(a.sellQuote, a.sellQuoteSmall + a.sellQuoteMedium + a.sellQuoteLarge)) failures.push('sell class sum != sellQuote');
  if (!(a.buyQuoteOpen10s <= a.buyQuote * (1 + INVARIANT_TOL))) failures.push('buyQuoteOpen10s > buyQuote');
  if (!(a.sellQuoteOpen10s <= a.sellQuote * (1 + INVARIANT_TOL))) failures.push('sellQuoteOpen10s > sellQuote');
  return failures;
}

export interface Bands {
  exact: number;
  le1e9: number;
  le1e6: number;
  le1e3: number;
  gt1e3: number;
}

export interface WorstEntry {
  bucketStart: string;
  archive: number;
  kline: number;
  relErr: number;
}

export interface MetricStats {
  bands: Bands;
  worst: WorstEntry[];
}

export interface InvariantFailure {
  bucketStart: string;
  failures: string[];
}

export interface SymbolAccumulator {
  symbol: string;
  klineBuckets: number;
  archiveBuckets: number;
  compared: number;
  missingInArchive: number;
  missingInKlines: number;
  zeroTradeKlines: number;
  takerBuyUnavailable: number;
  volume: MetricStats;
  quoteVolume: MetricStats;
  takerBuy: MetricStats;
  tradesMismatch: { count: number; worst: WorstEntry[] };
  invariantFailures: { count: number; first: InvariantFailure[] };
}

export interface SymbolResult extends SymbolAccumulator {
  pass: boolean;
}

function emptyMetric(): MetricStats {
  return { bands: { exact: 0, le1e9: 0, le1e6: 0, le1e3: 0, gt1e3: 0 }, worst: [] };
}

export function createAccumulator(symbol: string): SymbolAccumulator {
  return {
    symbol,
    klineBuckets: 0,
    archiveBuckets: 0,
    compared: 0,
    missingInArchive: 0,
    missingInKlines: 0,
    zeroTradeKlines: 0,
    takerBuyUnavailable: 0,
    volume: emptyMetric(),
    quoteVolume: emptyMetric(),
    takerBuy: emptyMetric(),
    tradesMismatch: { count: 0, worst: [] },
    invariantFailures: { count: 0, first: [] },
  };
}

function bandOf(err: number, bands: Bands): void {
  if (err === 0) bands.exact++;
  else if (err <= 1e-9) bands.le1e9++;
  else if (err <= 1e-6) bands.le1e6++;
  else if (err <= 1e-3) bands.le1e3++;
  else bands.gt1e3++; // includes NaN
}

function pushWorst(list: WorstEntry[], entry: WorstEntry): void {
  list.push(entry);
  list.sort((x, y) => (Number.isNaN(y.relErr) ? Infinity : y.relErr) - (Number.isNaN(x.relErr) ? Infinity : x.relErr) || x.bucketStart.localeCompare(y.bucketStart));
  if (list.length > WORST_N) list.length = WORST_N;
}

function record(stats: MetricStats, start: number, archive: number, kline: number, err: number): void {
  bandOf(err, stats.bands);
  if (err !== 0) pushWorst(stats.worst, { bucketStart: new Date(start).toISOString(), archive, kline, relErr: err });
}

/** Joins one symbol-month of archive buckets and kline rows into the accumulator. */
export function addMonth(acc: SymbolAccumulator, archive: readonly ArchiveBar[], klines: readonly KlineBar[]): void {
  const byStart = new Map(archive.map((a) => [a.bucketStart, a]));
  const seen = new Set<number>();
  acc.archiveBuckets += archive.length;

  for (const a of archive) {
    const failures = checkInvariants(a);
    if (failures.length > 0) {
      acc.invariantFailures.count++;
      if (acc.invariantFailures.first.length < WORST_N) {
        acc.invariantFailures.first.push({ bucketStart: new Date(a.bucketStart).toISOString(), failures });
      }
    }
  }

  for (const k of klines) {
    acc.klineBuckets++;
    if (k.trades === 0) acc.zeroTradeKlines++;
    const a = byStart.get(k.timestamp);
    if (!a) {
      if (k.trades > 0) acc.missingInArchive++;
      continue;
    }
    seen.add(k.timestamp);
    acc.compared++;
    const c = compareBucket(a, k);
    record(acc.volume, k.timestamp, a.buyBase + a.sellBase, k.volume, c.volume);
    record(acc.quoteVolume, k.timestamp, a.buyQuote + a.sellQuote, k.quoteVolume, c.quoteVolume);
    if (c.takerBuy === null) acc.takerBuyUnavailable++;
    else record(acc.takerBuy, k.timestamp, a.buyBase, k.takerBuyVolume as number, c.takerBuy);
    if (!c.tradesMatch) {
      acc.tradesMismatch.count++;
      pushWorst(acc.tradesMismatch.worst, {
        bucketStart: new Date(k.timestamp).toISOString(),
        archive: a.trades,
        kline: k.trades,
        relErr: relErr(a.trades, k.trades),
      });
    }
  }

  for (const a of archive) if (!seen.has(a.bucketStart)) acc.missingInKlines++;
}

function withinTolerance(bands: Bands): number {
  return bands.exact + bands.le1e9 + bands.le1e6;
}

/** within / total >= 99.9%, in integer arithmetic so the boundary is exact. */
function atLeastPassFraction(within: number, total: number): boolean {
  return total > 0 && within * PASS_FRACTION_DEN >= total * PASS_FRACTION_NUM;
}

export function finalize(acc: SymbolAccumulator): SymbolResult {
  const takerAvailable = acc.compared - acc.takerBuyUnavailable;
  const coverage = acc.missingInArchive === 0 && acc.missingInKlines === 0;
  const agreement =
    atLeastPassFraction(withinTolerance(acc.volume.bands), acc.compared) &&
    atLeastPassFraction(withinTolerance(acc.quoteVolume.bands), acc.compared) &&
    atLeastPassFraction(withinTolerance(acc.takerBuy.bands), takerAvailable) &&
    atLeastPassFraction(acc.compared - acc.tradesMismatch.count, acc.compared);
  const invariants = acc.invariantFailures.count === 0;
  return { ...acc, pass: coverage && agreement && invariants };
}

export interface ParsedArgs {
  symbols: string[];
  from: string;
  to: string;
  mongoUri: string | null;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

function checkMonth(value: string, flag: string): void {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error(`${flag} must be YYYY-MM`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  let symbols: string[] = [...SIGNAL_SYMBOLS];
  let from = DEFAULT_FROM;
  let to = DEFAULT_TO;
  let mongoUri: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--symbols':
        symbols = nextValue(argv, ++i, '--symbols').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--from':
        from = nextValue(argv, ++i, '--from');
        break;
      case '--to':
        to = nextValue(argv, ++i, '--to');
        break;
      case '--mongo-uri':
        mongoUri = nextValue(argv, ++i, '--mongo-uri');
        break;
      default:
        throw new Error(`Unknown flag "${argv[i]}"`);
    }
  }

  checkMonth(from, '--from');
  checkMonth(to, '--to');
  if (symbols.length === 0) throw new Error('--symbols needs at least one symbol');
  // YYYY-MM strings compare correctly as text.
  if (to >= LOCKBOX_MONTH) throw new Error(`--to ${to} is inside the lockbox (${LOCKBOX_MONTH} onward is never read)`);
  if (from > to) throw new Error('--from must not be after --to');
  return { symbols, from, to, mongoUri };
}

function monthsBetween(from: string, to: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push({ start: Date.UTC(y, m - 1, 1), end: Date.UTC(y, m, 1) });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mongoUri) process.env.MONGODB_URI = args.mongoUri;
  await connectDB();

  const months = monthsBetween(args.from, args.to);
  const failedSymbols: string[] = [];

  for (const symbol of args.symbols) {
    const acc = createAccumulator(symbol);
    for (const { start, end } of months) {
      const [archive, klines] = await Promise.all([
        ArchiveFlowBar.find({ symbol, bucketStart: { $gte: start, $lt: end } })
          .select({
            _id: 0,
            bucketStart: 1,
            trades: 1,
            buyBase: 1,
            sellBase: 1,
            buyQuote: 1,
            sellQuote: 1,
            buyQuoteSmall: 1,
            buyQuoteMedium: 1,
            buyQuoteLarge: 1,
            sellQuoteSmall: 1,
            sellQuoteMedium: 1,
            sellQuoteLarge: 1,
            buyQuoteOpen10s: 1,
            sellQuoteOpen10s: 1,
          })
          .lean<ArchiveBar[]>(),
        PerpCandle.find({ symbol, interval: '5m', series: 'klines', timestamp: { $gte: start, $lt: end } })
          .select({ _id: 0, timestamp: 1, volume: 1, quoteVolume: 1, trades: 1, takerBuyVolume: 1 })
          .lean<KlineBar[]>(),
      ]);
      addMonth(acc, archive, klines);
    }
    const result = finalize(acc);
    if (!result.pass) failedSymbols.push(symbol);
    console.log(JSON.stringify(result));
  }

  const pass = failedSymbols.length === 0;
  console.log(JSON.stringify({ summary: true, symbols: args.symbols.length, pass, failedSymbols }));
  return pass ? 0 : 2;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
