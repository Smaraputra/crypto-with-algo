/**
 * Extractor validation for the QH-FLOW phase (header of scripts/research/qh-flow.ts,
 * EXTRACTOR VALIDATION): folds one DAILY Binance UM aggTrades file with the
 * archive-flow extractor and compares it with the live recorder's
 * `tradeflowbars` documents for the same symbol and day, complete buckets only.
 *
 * It compares flow sums only (total taker buy quote and total taker sell
 * quote) and reads no price, return or factor. Pass: at least 95% of the
 * compared buckets agree within 0.5% on BOTH sums, and at least 12 buckets
 * were compared. Also reported, NOT part of the pass rule: the same agreement for
 * large-class and small-class taker buy and sell quote (`classAgreement`). Prints one JSON line and exits 0 on pass, 2 on fail, 1 on error.
 *
 * Usage:
 *   npx tsx scripts/ops/validate-agg-flow.ts --symbol BTCUSDT --date 2026-10-08 [--mongo-uri <uri>]
 *
 * Needs MONGODB_URI (or --mongo-uri) pointing at a database the recorder wrote
 * to, so it runs on the VPS. The pure comparison is `compareFlow`.
 */
import { connectDB } from '@/lib/mongodb';
import { TradeFlowBar } from '@/lib/models/trade-flow-bar';
import { foldArchiveFile } from '@/lib/archive-flow/fold-file';

/** A bucket agrees when both relative differences are at most this. */
export const TOLERANCE = 0.005;
export const PASS_FRACTION = 0.95;
export const MIN_BUCKETS = 12;
const DAY_MS = 86_400_000;

export const CLASS_FIELDS = ['buyQuoteLarge', 'sellQuoteLarge', 'buyQuoteSmall', 'sellQuoteSmall'] as const;
export type ClassField = (typeof CLASS_FIELDS)[number];

export interface FlowSums {
  bucketStart: number;
  buyQuote: number;
  sellQuote: number;
  buyQuoteLarge?: number;
  sellQuoteLarge?: number;
  buyQuoteSmall?: number;
  sellQuoteSmall?: number;
}

/** Agreement of one size-class quantity over the buckets both sides carry it for. Reported only. */
export interface ClassAgreement {
  compared: number;
  within: number;
  fraction: number;
}

export interface WorstBucket {
  bucketStart: number;
  archiveBuy: number;
  recorderBuy: number;
  archiveSell: number;
  recorderSell: number;
  worstRelDiff: number;
}

export interface FlowComparison {
  bucketsCompared: number;
  bucketsWithin: number;
  passFraction: number;
  pass: boolean;
  worst: WorstBucket[];
  /** Per size-class quantity, within the same 0.5% tolerance. Not part of the pass rule. */
  classAgreement: Record<ClassField, ClassAgreement>;
}

/** Relative difference to the recorder value; a zero reference agrees only with zero. */
function relDiff(archive: number, recorder: number): number {
  if (recorder === 0) return archive === 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(archive - recorder) / Math.abs(recorder);
}

export function compareFlow(archive: readonly FlowSums[], recorder: readonly FlowSums[]): FlowComparison {
  const byStart = new Map(recorder.map((b) => [b.bucketStart, b]));
  const rows: WorstBucket[] = [];
  let within = 0;
  const classCounts = Object.fromEntries(CLASS_FIELDS.map((f) => [f, { compared: 0, within: 0 }])) as Record<
    ClassField,
    { compared: number; within: number }
  >;

  for (const a of archive) {
    const r = byStart.get(a.bucketStart);
    if (!r) continue;
    const worstRelDiff = Math.max(relDiff(a.buyQuote, r.buyQuote), relDiff(a.sellQuote, r.sellQuote));
    if (worstRelDiff <= TOLERANCE) within++;
    for (const field of CLASS_FIELDS) {
      const av = a[field];
      const rv = r[field];
      if (av === undefined || rv === undefined) continue;
      classCounts[field].compared++;
      if (relDiff(av, rv) <= TOLERANCE) classCounts[field].within++;
    }
    rows.push({
      bucketStart: a.bucketStart,
      archiveBuy: a.buyQuote,
      recorderBuy: r.buyQuote,
      archiveSell: a.sellQuote,
      recorderSell: r.sellQuote,
      worstRelDiff,
    });
  }

  const compared = rows.length;
  const passFraction = compared === 0 ? 0 : within / compared;
  rows.sort((x, y) => y.worstRelDiff - x.worstRelDiff || x.bucketStart - y.bucketStart);
  return {
    bucketsCompared: compared,
    bucketsWithin: within,
    passFraction,
    pass: compared >= MIN_BUCKETS && passFraction >= PASS_FRACTION,
    worst: rows.slice(0, 5),
    classAgreement: Object.fromEntries(
      CLASS_FIELDS.map((f) => [
        f,
        { ...classCounts[f], fraction: classCounts[f].compared === 0 ? 0 : classCounts[f].within / classCounts[f].compared },
      ])
    ) as Record<ClassField, ClassAgreement>,
  };
}

export interface ParsedArgs {
  symbol: string;
  date: string;
  mongoUri: string | null;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let symbol: string | null = null;
  let date: string | null = null;
  let mongoUri: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--symbol':
        symbol = nextValue(argv, ++i, '--symbol');
        break;
      case '--date':
        date = nextValue(argv, ++i, '--date');
        break;
      case '--mongo-uri':
        mongoUri = nextValue(argv, ++i, '--mongo-uri');
        break;
      default:
        throw new Error(`Unknown flag "${argv[i]}"`);
    }
  }

  if (!symbol) throw new Error('--symbol is required');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error('--date is required and must be YYYY-MM-DD');
  }
  return { symbol, date, mongoUri };
}

export async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mongoUri) process.env.MONGODB_URI = args.mongoUri;

  const folded = await foldArchiveFile({
    dataset: 'aggTrades',
    symbol: args.symbol,
    date: args.date,
    cadence: 'daily',
  });
  if (folded.status === 'missing') throw new Error(`No daily aggTrades file for ${args.symbol} ${args.date}`);
  if (folded.outOfOrder > 0) {
    throw new Error(`${folded.outOfOrder} rows went backwards beyond the open bucket; the fold is not trustworthy`);
  }

  await connectDB();
  const dayStart = Date.parse(`${args.date}T00:00:00Z`);
  const docs = await TradeFlowBar.find({
    symbol: args.symbol,
    complete: true,
    bucketStart: { $gte: dayStart, $lt: dayStart + DAY_MS },
  })
    .select({
      bucketStart: 1,
      buyQuote: 1,
      sellQuote: 1,
      buyQuoteLarge: 1,
      sellQuoteLarge: 1,
      buyQuoteSmall: 1,
      sellQuoteSmall: 1,
      _id: 0,
    })
    .lean<FlowSums[]>();

  const comparison = compareFlow(folded.buckets, docs);
  console.log(
    JSON.stringify({
      symbol: args.symbol,
      date: args.date,
      bucketsCompared: comparison.bucketsCompared,
      bucketsWithin: comparison.bucketsWithin,
      passFraction: comparison.passFraction,
      pass: comparison.pass,
      worst: comparison.worst,
      classAgreement: comparison.classAgreement,
    })
  );
  return comparison.pass ? 0 : 2;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
