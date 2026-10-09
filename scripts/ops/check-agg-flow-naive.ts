/**
 * Independent re-derivation check of `archiveflowbars` for the QH-FLOW research
 * phase (header of scripts/research/qh-flow.ts, COLUMNS and DATA sections). The
 * stored 5-minute taker flow buckets were folded from Binance UM aggTrades
 * MONTHLY archive files by `FlowFolder`. The kline check
 * (check-agg-flow-klines.ts) cannot test that fold exactly, because Binance
 * klines bucket each fill by its own time while the fold buckets an aggregate
 * trade by its `transact_time`. This script re-sums sampled DAILY archive files
 * with a second implementation and requires exact agreement. It therefore also
 * tests that the monthly files the ingest read carry the same trades as the
 * daily files.
 *
 * Independence: the naive fold below imports nothing from src/lib/archive-flow/
 * and nothing from the recorder (no FlowFolder, parseAggTradeLine, bucketStartOf,
 * sizeClassOf or aggressorOf). It is written from the definitions here, and it
 * keeps every bucket in a map keyed by bucket start, so it needs no ordering
 * assumption. Only the archive READER (streamArchiveCsvLines) is shared.
 *
 * Definitions:
 *   - CSV columns: agg_trade_id,price,quantity,first_trade_id,last_trade_id,
 *     transact_time,is_buyer_maker. A header line (first field not all digits)
 *     is skipped.
 *   - Bucket = floor(transact_time / 300000) * 300000.
 *   - Taker side: is_buyer_maker true means the taker SOLD (sell), false means
 *     the taker BOUGHT (buy).
 *   - Quote = price * quantity. Size class by that quote: small < 10000,
 *     medium >= 10000 and < 100000, large >= 100000.
 *   - Per bucket: buyBase, sellBase, buyQuote, sellQuote, buyQuoteSmall/Medium/
 *     Large, sellQuoteSmall/Medium/Large, buyQuoteOpen10s, sellQuoteOpen10s
 *     (trades with transact_time - bucket < 10000), trades (sum of
 *     last - first + 1), aggTrades (row count).
 *   - Sums are plain += in file order (the archive's order).
 *   - Relative error is |a - b| / max(|b|, 1e-12), b the naive value. Counts
 *     (trades, aggTrades) are compared exactly.
 *
 * PASS RULE (declared before any run, do not change it):
 *   For every sampled (symbol, day): the bucket sets are identical, every count
 *   field is equal, and every numeric field has relative error <= 1e-9. The run
 *   passes when every sample passes. A file reported missing fails its sample
 *   (status `missing`).
 *
 * It reads no price series, return or factor from Mongo, only the stored flow
 * buckets (archiveflowbars) of the sampled symbol and UTC day. READ-ONLY:
 * nothing is written. One file is processed at a time.
 *
 * LOCKBOX: nothing from 2026-07-01 onward is read. Any such date is refused
 * before connecting or downloading.
 *
 * Usage:
 *   docker run --rm --network crypto_crypto-internal --env-file /opt/sites/crypto/.env crypto-ops:<tag> npx --yes tsx scripts/ops/check-agg-flow-naive.ts [flags]
 *
 * Flags:
 *   --symbols BTCUSDT,ETHUSDT   default SIGNAL_SYMBOLS
 *   --dates 2024-01-15,...      default 2023-01-15, 2023-07-15, 2024-01-15, 2024-07-15,
 *                               2025-01-15, 2025-07-15, 2026-01-15, 2026-06-15
 *   --mongo-uri <uri>           overrides MONGODB_URI
 *
 * Output: one JSON line per sample { symbol, date, status, lines, naiveBuckets,
 * storedBuckets, missingInStored, missingInNaive, countMismatches, worstRelErr,
 * worstField, worstBucket, pass }, then { summary: true, samples, passed,
 * failed: ['SYMBOL:DATE', ...], pass }. Exit 0 on pass, 2 on fail, 1 on error
 * (message on stderr).
 */
import { connectDB } from '@/lib/mongodb';
import { ArchiveFlowBar } from '@/lib/models/archive-flow-bar';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { streamArchiveCsvLines } from '@/lib/external/binance-archive';

export const DEFAULT_DATES = [
  '2023-01-15',
  '2023-07-15',
  '2024-01-15',
  '2024-07-15',
  '2025-01-15',
  '2025-07-15',
  '2026-01-15',
  '2026-06-15',
] as const;

const LOCKBOX_DATE = '2026-07-01';
const REL_FLOOR = 1e-12;
const REL_TOL = 1e-9;
const BUCKET_MS = 300_000;
const OPEN_MS = 10_000;
const SMALL_MAX = 10_000;
const LARGE_MIN = 100_000;
const DAY_MS = 86_400_000;

export const COUNT_FIELDS = ['trades', 'aggTrades'] as const;
export const NUMERIC_FIELDS = [
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

export interface NaiveBucket {
  bucketStart: number;
  trades: number;
  aggTrades: number;
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

/** A stored archiveflowbars document, projected to the compared fields. */
export type StoredBar = NaiveBucket;

function blank(bucketStart: number): NaiveBucket {
  return {
    bucketStart,
    trades: 0,
    aggTrades: 0,
    buyBase: 0,
    sellBase: 0,
    buyQuote: 0,
    sellQuote: 0,
    buyQuoteSmall: 0,
    buyQuoteMedium: 0,
    buyQuoteLarge: 0,
    sellQuoteSmall: 0,
    sellQuoteMedium: 0,
    sellQuoteLarge: 0,
    buyQuoteOpen10s: 0,
    sellQuoteOpen10s: 0,
  };
}

/** Adds one CSV line to the map; a header line is skipped. */
export function addNaiveLine(buckets: Map<number, NaiveBucket>, line: string): void {
  const f = line.split(',');
  if (!/^\d+$/.test(f[0]?.trim() ?? '')) return;
  if (f.length !== 7) throw new Error(`Malformed aggTrades row: ${line}`);

  const price = Number(f[1]);
  const qty = Number(f[2]);
  const first = Number(f[3]);
  const last = Number(f[4]);
  const time = Number(f[5]);
  const flag = f[6].trim().toLowerCase();
  if (
    f[1].trim() === '' ||
    f[2].trim() === '' ||
    !Number.isFinite(price) ||
    !Number.isFinite(qty) ||
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    !Number.isInteger(time) ||
    (flag !== 'true' && flag !== 'false')
  ) {
    throw new Error(`Malformed aggTrades row: ${line}`);
  }

  const start = Math.floor(time / BUCKET_MS) * BUCKET_MS;
  let b = buckets.get(start);
  if (!b) {
    b = blank(start);
    buckets.set(start, b);
  }
  const quote = price * qty;
  const cls = quote < SMALL_MAX ? 'Small' : quote < LARGE_MIN ? 'Medium' : 'Large';
  const open = time - start < OPEN_MS;

  b.trades += last - first + 1;
  b.aggTrades += 1;
  if (flag === 'true') {
    b.sellBase += qty;
    b.sellQuote += quote;
    b[`sellQuote${cls}`] += quote;
    if (open) b.sellQuoteOpen10s += quote;
  } else {
    b.buyBase += qty;
    b.buyQuote += quote;
    b[`buyQuote${cls}`] += quote;
    if (open) b.buyQuoteOpen10s += quote;
  }
}

/** Folds CSV lines (in file order) into buckets keyed by bucket start. */
export function naiveFold(lines: Iterable<string>): Map<number, NaiveBucket> {
  const buckets = new Map<number, NaiveBucket>();
  for (const line of lines) addNaiveLine(buckets, line);
  return buckets;
}

function relErr(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(b), REL_FLOOR);
}

export interface DayComparison {
  naiveBuckets: number;
  storedBuckets: number;
  missingInStored: number;
  missingInNaive: number;
  countMismatches: number;
  worstRelErr: number;
  worstField: string | null;
  worstBucket: string | null;
  pass: boolean;
}

/** Compares one symbol-day: naive buckets (b) against the stored documents (a). */
export function compareDay(naive: ReadonlyMap<number, NaiveBucket>, stored: readonly StoredBar[]): DayComparison {
  const byStart = new Map<number, StoredBar>();
  for (const s of stored) byStart.set(s.bucketStart, s);

  let missingInStored = 0;
  let countMismatches = 0;
  let worstRelErr = 0;
  let worstField: string | null = null;
  let worstBucket: string | null = null;
  let overTolerance = 0;

  for (const [start, n] of naive) {
    const s = byStart.get(start);
    if (!s) {
      missingInStored++;
      continue;
    }
    for (const f of COUNT_FIELDS) {
      if (s[f] !== n[f]) {
        countMismatches++;
        if (worstField === null) {
          worstField = f;
          worstBucket = new Date(start).toISOString();
        }
      }
    }
    for (const f of NUMERIC_FIELDS) {
      const raw = relErr(s[f], n[f]);
      const e = Number.isNaN(raw) ? Infinity : raw;
      if (e > REL_TOL) overTolerance++;
      if (e > worstRelErr) {
        worstRelErr = e;
        worstField = f;
        worstBucket = new Date(start).toISOString();
      }
    }
  }
  let missingInNaive = 0;
  for (const start of byStart.keys()) if (!naive.has(start)) missingInNaive++;

  const pass = missingInStored === 0 && missingInNaive === 0 && countMismatches === 0 && overTolerance === 0;
  return {
    naiveBuckets: naive.size,
    storedBuckets: byStart.size,
    missingInStored,
    missingInNaive,
    countMismatches,
    worstRelErr,
    worstField,
    worstBucket,
    pass,
  };
}

export interface ParsedArgs {
  symbols: string[];
  dates: string[];
  mongoUri: string | null;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let symbols: string[] = [...SIGNAL_SYMBOLS];
  let dates: string[] = [...DEFAULT_DATES];
  let mongoUri: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--symbols':
        symbols = nextValue(argv, ++i, '--symbols').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--dates':
        dates = nextValue(argv, ++i, '--dates').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--mongo-uri':
        mongoUri = nextValue(argv, ++i, '--mongo-uri');
        break;
      default:
        throw new Error(`Unknown flag "${argv[i]}"`);
    }
  }

  if (symbols.length === 0) throw new Error('--symbols needs at least one symbol');
  if (dates.length === 0) throw new Error('--dates needs at least one date');
  for (const d of dates) {
    if (!validDate(d)) throw new Error(`--dates entry "${d}" must be a real date as YYYY-MM-DD`);
    // YYYY-MM-DD strings compare correctly as text.
    if (d >= LOCKBOX_DATE) throw new Error(`--dates entry ${d} is inside the lockbox (${LOCKBOX_DATE} onward is never read)`);
  }
  return { symbols, dates, mongoUri };
}

async function checkSample(symbol: string, date: string): Promise<Record<string, unknown> & { pass: boolean }> {
  let naive = new Map<number, NaiveBucket>();
  const result = await streamArchiveCsvLines(
    { dataset: 'aggTrades', symbol, date, cadence: 'daily' },
    (line) => addNaiveLine(naive, line),
    { onRestart: () => { naive = new Map(); } }
  );
  if (result.status === 'missing') {
    return {
      symbol,
      date,
      status: 'missing',
      lines: 0,
      naiveBuckets: 0,
      storedBuckets: 0,
      missingInStored: 0,
      missingInNaive: 0,
      countMismatches: 0,
      worstRelErr: null,
      worstField: null,
      worstBucket: null,
      pass: false,
    };
  }

  const dayStart = Date.parse(`${date}T00:00:00Z`);
  const stored = await ArchiveFlowBar.find({ symbol, bucketStart: { $gte: dayStart, $lt: dayStart + DAY_MS } })
    .select({
      _id: 0,
      bucketStart: 1,
      trades: 1,
      aggTrades: 1,
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
    .lean<StoredBar[]>();

  const cmp = compareDay(naive, stored);
  return { symbol, date, status: 'ok', lines: result.lines, ...cmp };
}

export async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mongoUri) process.env.MONGODB_URI = args.mongoUri;
  await connectDB();

  const failed: string[] = [];
  let samples = 0;
  for (const symbol of args.symbols) {
    for (const date of args.dates) {
      const row = await checkSample(symbol, date);
      samples++;
      if (!row.pass) failed.push(`${symbol}:${date}`);
      console.log(JSON.stringify(row));
    }
  }

  const pass = failed.length === 0;
  console.log(JSON.stringify({ summary: true, samples, passed: samples - failed.length, failed, pass }));
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
