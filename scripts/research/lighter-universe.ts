/**
 * COST-ONLY UNIVERSE SELECTION FOR LIGHTER PERP MARKETS.
 *
 * PURPOSE.
 * Chooses which Lighter perp markets a study may trade. The rule reads COST DATA ONLY: how many
 * distinct recorder runs a market was seen in, the round-trip slippage at 1,000 USD, and open
 * interest. It never reads a price, a mark, an index, a funding rate or a return, so the choice is
 * blind to performance. The module projects every snapshot row onto the seven fields below and
 * drops everything else at the door (`toCostRow`), and a unit test pins that list.
 *
 * INPUTS (files only, no network).
 * - --snapshots-dir: folder of JSON Lines files (*.jsonl) written hourly by `venue-recorder.ts`. Each run
 *   starts with a manifest line followed by one row per venue and coin. `ts` is the same for every
 *   row of a run. Slippage fields can be null.
 * - --order-books: a saved response of Lighter GET /api/v1/orderBooks.
 * - --out: output JSON path. --min-runs: minimum number of runs a market must be priced in (default 150).
 *
 * THE RULE, EXACTLY.
 * 1. Candidates are venue "lighter" rows whose symbol maps to an order_books entry with
 *    market_type "perp" and status "active".
 * 2. The market must appear in at least --min-runs distinct runs (distinct ts) with non-null
 *    buySlipBps and sellSlipBps. Those are its "priced runs".
 * 3. roundTrip = median over the priced runs of (buySlipBps + sellSlipBps). Keep when roundTrip <= 2.5.
 * 4. Median oiUsd over the priced runs with a non-null oiUsd must be >= 2,000,000. No oiUsd at all fails.
 * 5. tier = "A" when roundTrip <= 1.0, else "B".
 * 6. binanceSymbol = the `symbol` of the coin's venue "binance" rows when the coin has binance rows in
 *    at least half of its priced runs, else null. A coin with several binance symbols takes the most
 *    frequent one, ties broken alphabetically.
 *
 * OUTPUT. { rule, generatedFrom, markets } with markets sorted by roundTripBps, then coin. The output
 * is deterministic: the same inputs give byte-identical output. The sha256 of the markets array is
 * printed to stdout.
 *
 * RESULT: not run yet.
 *
 * Usage:
 *   npx tsx scripts/research/lighter-universe.ts --snapshots-dir <DIR> --order-books <JSON> --out <JSON> [--min-runs 150]
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_MIN_RUNS = 150;
export const MAX_ROUND_TRIP_BPS = 2.5;
export const TIER_A_ROUND_TRIP_BPS = 1.0;
export const MIN_MEDIAN_OI_USD = 2_000_000;
export const BINANCE_COVERAGE = 0.5;

/** The only snapshot fields this module reads. A unit test pins this list. */
export const COST_FIELDS = ['ts', 'venue', 'coin', 'symbol', 'oiUsd', 'buySlipBps', 'sellSlipBps'] as const;

export interface CostRow {
  ts: number;
  venue: string;
  coin: string;
  symbol: string;
  oiUsd: number | null;
  buySlipBps: number | null;
  sellSlipBps: number | null;
}

export interface OrderBookEntry {
  symbol: string;
  marketId: number;
  priceDecimals: number | null;
  sizeDecimals: number | null;
}

export interface UniverseMarket {
  coin: string;
  lighterMarketId: number;
  lighterSymbol: string;
  binanceSymbol: string | null;
  tier: 'A' | 'B';
  roundTripBps: number;
  medianOiUsd: number;
  runs: number;
  priceDecimals: number | null;
  sizeDecimals: number | null;
}

export interface UniverseOutput {
  rule: {
    minRuns: number;
    maxRoundTripBps: number;
    tierARoundTripBps: number;
    minMedianOiUsd: number;
    binanceCoverage: number;
    fields: readonly string[];
  };
  generatedFrom: { runs: number; firstTs: number | null; lastTs: number | null; files: string[] };
  markets: UniverseMarket[];
}

export interface UniverseArgs {
  snapshotsDir: string;
  orderBooks: string;
  out: string;
  minRuns: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function finiteOrNull(val: unknown): number | null {
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'string' && val.trim() !== '') {
    const num = Number(val);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/**
 * Projects one parsed snapshot line onto the cost fields. Returns null for a manifest line or a row
 * that lacks a usable ts, venue, coin or symbol. Every other field of the line is dropped here.
 */
export function toCostRow(value: unknown): CostRow | null {
  const rec = asRecord(value);
  if (!rec || rec.manifest === true) return null;
  const ts = finiteOrNull(rec.ts);
  if (ts === null) return null;
  if (typeof rec.venue !== 'string' || typeof rec.coin !== 'string' || typeof rec.symbol !== 'string') return null;
  return {
    ts,
    venue: rec.venue,
    coin: rec.coin,
    symbol: rec.symbol,
    oiUsd: finiteOrNull(rec.oiUsd),
    buySlipBps: finiteOrNull(rec.buySlipBps),
    sellSlipBps: finiteOrNull(rec.sellSlipBps),
  };
}

export interface ParsedSnapshotText {
  rows: CostRow[];
  /** Every ts seen on a manifest line or a usable row. */
  runTimestamps: number[];
}

/** Parses the text of one JSON Lines file. A malformed line throws, naming the file and line. */
export function parseSnapshotText(text: string, label = 'snapshot'): ParsedSnapshotText {
  const rows: CostRow[] = [];
  const runTimestamps: number[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${label}: line ${i + 1} is not valid JSON`);
    }
    const rec = asRecord(parsed);
    if (rec && rec.manifest === true) {
      const manifestTs = finiteOrNull(rec.ts);
      if (manifestTs !== null) runTimestamps.push(manifestTs);
      continue;
    }
    const row = toCostRow(parsed);
    if (row) {
      rows.push(row);
      runTimestamps.push(row.ts);
    }
  }
  return { rows, runTimestamps };
}

/** Parses a saved Lighter orderBooks response, keeping perp markets with status active. */
export function parseOrderBooks(json: unknown): Map<string, OrderBookEntry> {
  const rec = asRecord(json);
  const list = rec && Array.isArray(rec.order_books) ? rec.order_books : Array.isArray(json) ? json : [];
  const out = new Map<string, OrderBookEntry>();
  for (const item of list) {
    const r = asRecord(item);
    if (!r || typeof r.symbol !== 'string') continue;
    if (r.market_type !== 'perp' || r.status !== 'active') continue;
    const marketId = finiteOrNull(r.market_id);
    if (marketId === null) continue;
    out.set(r.symbol, {
      symbol: r.symbol,
      marketId,
      priceDecimals: finiteOrNull(r.supported_price_decimals),
      sizeDecimals: finiteOrNull(r.supported_size_decimals),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Applies the rule to cost rows and the active perp market list. Pure. */
export function selectUniverse(
  rows: readonly CostRow[],
  orderBooks: ReadonlyMap<string, OrderBookEntry>,
  minRuns: number = DEFAULT_MIN_RUNS
): UniverseMarket[] {
  // Priced runs per lighter symbol: ts -> { roundTrip, oiUsd }, first usable row per ts wins.
  interface Priced {
    coin: string;
    runs: Map<number, { roundTrip: number; oiUsd: number | null }>;
  }
  const priced = new Map<string, Priced>();
  // Binance rows per coin: ts -> symbols seen.
  const binance = new Map<string, Map<number, string>>();

  for (const row of rows) {
    if (row.venue === 'binance') {
      let perTs = binance.get(row.coin);
      if (!perTs) {
        perTs = new Map();
        binance.set(row.coin, perTs);
      }
      if (!perTs.has(row.ts)) perTs.set(row.ts, row.symbol);
      continue;
    }
    if (row.venue !== 'lighter') continue;
    if (!orderBooks.has(row.symbol)) continue;
    if (row.buySlipBps === null || row.sellSlipBps === null) continue;

    let entry = priced.get(row.symbol);
    if (!entry) {
      entry = { coin: row.coin, runs: new Map() };
      priced.set(row.symbol, entry);
    } else if (compareStrings(row.coin, entry.coin) < 0) {
      entry.coin = row.coin;
    }
    if (!entry.runs.has(row.ts)) {
      entry.runs.set(row.ts, { roundTrip: row.buySlipBps + row.sellSlipBps, oiUsd: row.oiUsd });
    }
  }

  const markets: UniverseMarket[] = [];
  for (const [symbol, entry] of priced) {
    const book = orderBooks.get(symbol);
    if (!book) continue;
    const runTs = [...entry.runs.keys()].sort((a, b) => a - b);
    if (runTs.length < minRuns) continue;

    const roundTripBps = median(runTs.map((ts) => entry.runs.get(ts)!.roundTrip));
    if (!(roundTripBps <= MAX_ROUND_TRIP_BPS)) continue;

    const oiValues: number[] = [];
    for (const ts of runTs) {
      const oi = entry.runs.get(ts)!.oiUsd;
      if (oi !== null) oiValues.push(oi);
    }
    if (oiValues.length === 0) continue;
    const medianOiUsd = median(oiValues);
    if (!(medianOiUsd >= MIN_MEDIAN_OI_USD)) continue;

    let binanceSymbol: string | null = null;
    const perTs = binance.get(entry.coin);
    if (perTs) {
      const counts = new Map<string, number>();
      let covered = 0;
      for (const ts of runTs) {
        const bSymbol = perTs.get(ts);
        if (bSymbol === undefined) continue;
        covered++;
        counts.set(bSymbol, (counts.get(bSymbol) ?? 0) + 1);
      }
      if (covered >= BINANCE_COVERAGE * runTs.length) {
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]));
        binanceSymbol = ranked[0][0];
      }
    }

    markets.push({
      coin: entry.coin,
      lighterMarketId: book.marketId,
      lighterSymbol: symbol,
      binanceSymbol,
      tier: roundTripBps <= TIER_A_ROUND_TRIP_BPS ? 'A' : 'B',
      roundTripBps,
      medianOiUsd,
      runs: runTs.length,
      priceDecimals: book.priceDecimals,
      sizeDecimals: book.sizeDecimals,
    });
  }

  return markets.sort((a, b) => a.roundTripBps - b.roundTripBps || compareStrings(a.coin, b.coin));
}

export function marketsHash(markets: readonly UniverseMarket[]): string {
  return createHash('sha256').update(JSON.stringify(markets)).digest('hex');
}

/** Builds the full output object from parsed inputs. Pure. */
export function buildUniverse(
  parsed: readonly ParsedSnapshotText[],
  fileNames: readonly string[],
  orderBooks: ReadonlyMap<string, OrderBookEntry>,
  minRuns: number = DEFAULT_MIN_RUNS
): UniverseOutput {
  const rows: CostRow[] = [];
  const runs = new Set<number>();
  for (const part of parsed) {
    for (const row of part.rows) rows.push(row);
    for (const ts of part.runTimestamps) runs.add(ts);
  }
  const sortedRuns = [...runs].sort((a, b) => a - b);
  return {
    rule: {
      minRuns,
      maxRoundTripBps: MAX_ROUND_TRIP_BPS,
      tierARoundTripBps: TIER_A_ROUND_TRIP_BPS,
      minMedianOiUsd: MIN_MEDIAN_OI_USD,
      binanceCoverage: BINANCE_COVERAGE,
      fields: COST_FIELDS,
    },
    generatedFrom: {
      runs: sortedRuns.length,
      firstTs: sortedRuns.length > 0 ? sortedRuns[0] : null,
      lastTs: sortedRuns.length > 0 ? sortedRuns[sortedRuns.length - 1] : null,
      files: [...fileNames],
    },
    markets: selectUniverse(rows, orderBooks, minRuns),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): UniverseArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}"`);
    const key = arg.slice(2);
    if (!['snapshots-dir', 'order-books', 'out', 'min-runs'].includes(key)) {
      throw new Error(`Unknown flag "${arg}"`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for "${arg}"`);
    flags.set(key, value);
    i++;
  }

  for (const required of ['snapshots-dir', 'order-books', 'out']) {
    if (!flags.has(required)) throw new Error(`--${required} is required`);
  }

  let minRuns = DEFAULT_MIN_RUNS;
  if (flags.has('min-runs')) {
    const raw = flags.get('min-runs')!;
    if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`--min-runs must be a positive integer, got "${raw}"`);
    minRuns = Number(raw);
  }

  return {
    snapshotsDir: flags.get('snapshots-dir')!,
    orderBooks: flags.get('order-books')!,
    out: flags.get('out')!,
    minRuns,
  };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseArgs(argv);

  const files = readdirSync(args.snapshotsDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort(compareStrings);
  if (files.length === 0) throw new Error(`no .jsonl files in ${args.snapshotsDir}`);

  const parsed = files.map((name) => parseSnapshotText(readFileSync(join(args.snapshotsDir, name), 'utf8'), name));
  const orderBooks = parseOrderBooks(JSON.parse(readFileSync(args.orderBooks, 'utf8')));
  if (orderBooks.size === 0) throw new Error(`no active perp markets in ${args.orderBooks}`);

  const universe = buildUniverse(parsed, files, orderBooks, args.minRuns);
  writeFileSync(args.out, JSON.stringify(universe, null, 2) + '\n');

  console.log(`lighter-universe: ${universe.markets.length} markets from ${universe.generatedFrom.runs} runs, written to ${args.out}`);
  console.log(`markets sha256 ${marketsHash(universe.markets)}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
