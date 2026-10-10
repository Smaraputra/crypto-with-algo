/**
 * Read-only export of the stored live signal outcomes for the live-record study
 * (spec: header of scripts/research/live-record.ts).
 *
 * Reads SignalOutcome rows with source 'composite' (or no source, the legacy default, via
 * sourceMatch) and status 'resolved', every configVersion, and writes one gzipped JSONL file
 * sorted by (configVersion, tradingStyle, interval, candleTimestamp, symbol). Prints two JSON
 * lines: { out, rows, sha256, byVersion, cutoffMs } (cutoffMs is the export time) and the counts
 * of ALL statuses per version x style x interval. The sha256 covers the file bytes, so a re-export
 * of unchanged data reproduces it; cutoffMs is therefore not written into the file.
 *
 * Writes nothing to the database. Flags:
 *   --out <file>        default: live-outcomes-export.jsonl.gz
 *   --mongo-uri <uri>   override MONGODB_URI before connecting
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { SignalOutcome, sourceMatch } from '@/lib/models/signal-outcome';
import { connectDB } from '@/lib/mongodb';

export interface ExportRow {
  symbol: string;
  interval: string;
  tradingStyle: string;
  tier: string;
  score: number;
  configVersion: number;
  candleTimestamp: number;
  horizonBars: number;
  forwardReturnPercent: number;
}

export interface ParsedArgs {
  out: string;
  mongoUri: string | null;
}

export const DEFAULT_OUT = 'live-outcomes-export.jsonl.gz';

/** Projection of the fields exported; _id is dropped. */
export const EXPORT_PROJECTION = {
  _id: 0,
  symbol: 1,
  interval: 1,
  tradingStyle: 1,
  tier: 1,
  score: 1,
  configVersion: 1,
  candleTimestamp: 1,
  horizonBars: 1,
  forwardReturnPercent: 1,
} as const;

/** The exact filter: composite or legacy source rows that are resolved. */
export function exportMatch(): Record<string, unknown> {
  return { ...sourceMatch('composite'), status: 'resolved' };
}

export function parseArgs(argv: string[]): ParsedArgs {
  let out = DEFAULT_OUT;
  let mongoUri: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
      return v;
    };
    if (flag === '--out') out = value();
    else if (flag === '--mongo-uri') mongoUri = value();
    else throw new Error(`Unknown flag "${flag}"`);
  }
  return { out, mongoUri };
}

const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

/** Order: configVersion, tradingStyle, interval, candleTimestamp, symbol. */
export function compareRows(a: ExportRow, b: ExportRow): number {
  return (
    cmp(a.configVersion, b.configVersion) ||
    cmp(a.tradingStyle, b.tradingStyle) ||
    cmp(a.interval, b.interval) ||
    cmp(a.candleTimestamp, b.candleTimestamp) ||
    cmp(a.symbol, b.symbol)
  );
}

/** Fixed key order, so the bytes depend only on the data. */
export function toJsonLine(r: ExportRow): string {
  return JSON.stringify({
    configVersion: r.configVersion,
    tradingStyle: r.tradingStyle,
    interval: r.interval,
    candleTimestamp: r.candleTimestamp,
    symbol: r.symbol,
    tier: r.tier,
    score: r.score,
    horizonBars: r.horizonBars,
    forwardReturnPercent: r.forwardReturnPercent,
  });
}

/** Sorts a copy and serialises it to the gzipped JSONL bytes plus their sha256. */
export function serializeRows(rows: ExportRow[]): { rows: ExportRow[]; gz: Buffer; sha256: string } {
  const sorted = [...rows].sort(compareRows);
  const text = sorted.map(toJsonLine).join('\n') + (sorted.length > 0 ? '\n' : '');
  const gz = gzipSync(Buffer.from(text, 'utf8'));
  return { rows: sorted, gz, sha256: createHash('sha256').update(gz).digest('hex') };
}

export function countByVersion(rows: Pick<ExportRow, 'configVersion'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.configVersion)] = (out[String(r.configVersion)] ?? 0) + 1;
  return out;
}

export interface StatusCountRow {
  _id: { configVersion: number; tradingStyle: string; interval: string; status: string };
  count: number;
}

/** Counts of all statuses, keyed "version|style|interval", for the report's sizing table. */
export function foldStatusCounts(rows: StatusCountRow[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const key = `${r._id.configVersion}|${r._id.tradingStyle}|${r._id.interval}`;
    (out[key] ??= {})[r._id.status] = r.count;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => cmp(a, b)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.mongoUri) process.env.MONGODB_URI = args.mongoUri;
    await connectDB();

    const cutoffMs = Date.now();
    const docs = (await SignalOutcome.find(exportMatch(), EXPORT_PROJECTION).lean()) as unknown as ExportRow[];
    const rows = docs.filter((d) => typeof d.forwardReturnPercent === 'number');
    const { rows: sorted, gz, sha256 } = serializeRows(rows);
    writeFileSync(args.out, gz);

    console.log(
      JSON.stringify({ out: args.out, rows: sorted.length, sha256, byVersion: countByVersion(sorted), cutoffMs })
    );

    const statusRows: StatusCountRow[] = await SignalOutcome.aggregate([
      { $match: sourceMatch('composite') },
      {
        $group: {
          _id: { configVersion: '$configVersion', tradingStyle: '$tradingStyle', interval: '$interval', status: '$status' },
          count: { $sum: 1 },
        },
      },
    ]);
    console.log(JSON.stringify(foldStatusCounts(statusRows)));
    process.exit(0);
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
