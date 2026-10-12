// scripts/research/direction-exit-rows.ts
/**
 * Rows of the direction and exit study (spec: header of scripts/research/direction-exit.ts): every scored
 * bar of a cell with its v8 tier, the seven category scores, realizedVol20, its UTC hour, ATR(14) as a
 * percent of the close, the resolver's outcome, the lag-1 outcome (N1) and the price path to the horizon.
 *
 *   npx tsx scripts/research/direction-exit-rows.ts --dataset-dir <dir> --out <rows.jsonl.gz>
 *     --start <ISO> --end <ISO> --expect-manifest-hash <h> [--intervals 1h,4h] [--symbols A,B] [--scores-only]
 *
 * Reads only the exported dataset, after verifying it against its manifest and the expected hash. Writes the
 * rows and a sidecar <out>.meta.json (dataset hash, rows sha256, mode, window, commit) that the diagnosis and
 * the reproduction check assert. Prints { rows, dropped, pastWindowEnd, sha256, datasetHash, byCell }.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { intervalToMs } from '@/lib/intervals';
import { getTier } from '@/lib/signals/scorer';
import type { OHLCV } from '@/types/market';
import { atr } from './families/legends-indicators';
import { loadCandles, loadManifest, verifyManifest } from './load-dataset';
import { forwardReturnAt, loadCellMatrix } from './v8-rescore-build';
import { DIRECTION_EXIT_ATR_PERIOD, DIRECTION_EXIT_CELLS, DIRECTION_EXIT_SYMBOLS } from './direction-exit';

export const CATEGORIES = ['trend', 'momentum', 'volume', 'volatility', 'futures', 'sentiment', 'htf'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface DxRow {
  symbol: string;
  interval: string;
  style: string;
  t: number;
  score: number;
  tier: string;
  cats: Record<Category, number | null>;
  vol20: number | null;
  hourUtc: number;
  atrPct: number | null;
  fwd: number;
  fwd1: number | null;
  up: number;
  down: number;
  up1: number | null;
  down1: number | null;
}

export interface PathInput {
  t: ArrayLike<number>;
  o: ArrayLike<number>;
  h: ArrayLike<number>;
  l: ArrayLike<number>;
  c: ArrayLike<number>;
}

const pct = (a: number, b: number): number => ((a - b) / b) * 100;
const finiteOrNull = (v: number): number | null => (Number.isFinite(v) ? v : null);

/** Extremes over bars i+1..i+h from close[i] and from open[i+1]; null past the data end or across a gap. */
export function pathAt(p: PathInput, i: number, horizon: number, intervalMs: number) {
  if (i + horizon >= p.t.length) return null;
  for (let k = 1; k <= horizon; k++) if (p.t[i + k] !== p.t[i] + k * intervalMs) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = 1; k <= horizon; k++) {
    if (p.h[i + k] > hi) hi = p.h[i + k];
    if (p.l[i + k] < lo) lo = p.l[i + k];
  }
  const entry1 = p.o[i + 1];
  return {
    up: pct(hi, p.c[i]),
    down: pct(lo, p.c[i]),
    up1: finiteOrNull(pct(hi, entry1)),
    down1: finiteOrNull(pct(lo, entry1)),
    fwd1: finiteOrNull(pct(p.c[i + horizon], entry1)),
  };
}

export function buildDxRows(input: {
  symbol: string;
  interval: string;
  style: string;
  horizonBars: number;
  path: PathInput;
  names: string[];
  values: ArrayLike<number>[];
  atr14: ArrayLike<number>;
  window: { start: string; end: string };
  scoresOnly?: boolean;
}): { rows: DxRow[]; dropped: number; pastWindowEnd: number } {
  const col = (name: string): ArrayLike<number> | null => {
    const idx = input.names.indexOf(name);
    return idx >= 0 ? input.values[idx] : null;
  };
  const composite = col('composite');
  if (!composite) throw new Error('matrix has no composite column');
  const cats = CATEGORIES.map((c) => col(`cat.${c}`));
  const vol = col('raw.realizedVol20');
  const intervalMs = intervalToMs(input.interval);
  const startMs = Date.parse(input.window.start);
  const endMs = Date.parse(input.window.end);
  const rows: DxRow[] = [];
  let dropped = 0;
  let pastWindowEnd = 0;
  for (let i = 0; i < input.path.t.length; i++) {
    const t = input.path.t[i];
    if (t < startMs || t > endMs) continue;
    const score = composite[i];
    if (!Number.isFinite(score)) continue;
    let fwd = NaN;
    let path: ReturnType<typeof pathAt> = null;
    if (!input.scoresOnly) {
      // The whole horizon must end inside the window: bar i + h closes at t + (h + 1) bars - 1 ms (note N12).
      if (t + (input.horizonBars + 1) * intervalMs - 1 > endMs) {
        pastWindowEnd++;
        continue;
      }
      const r = forwardReturnAt(input.path.t, input.path.c, i, input.horizonBars, intervalMs);
      path = pathAt(input.path, i, input.horizonBars, intervalMs);
      if (r === null || path === null) {
        dropped++;
        continue;
      }
      fwd = r;
    }
    const catValues = Object.fromEntries(
      CATEGORIES.map((c, k) => [c, cats[k] ? finiteOrNull(cats[k]![i]) : null])
    ) as Record<Category, number | null>;
    const close = input.path.c[i];
    rows.push({
      symbol: input.symbol,
      interval: input.interval,
      style: input.style,
      t,
      score,
      tier: getTier(score),
      cats: catValues,
      vol20: vol ? finiteOrNull(vol[i]) : null,
      hourUtc: new Date(t).getUTCHours(),
      atrPct: finiteOrNull((input.atr14[i] / close) * 100),
      fwd,
      fwd1: path ? path.fwd1 : null,
      up: path ? path.up : NaN,
      down: path ? path.down : NaN,
      up1: path ? path.up1 : null,
      down1: path ? path.down1 : null,
    });
  }
  return { rows, dropped, pastWindowEnd };
}

/** Verifies every dataset file against the manifest and asserts the manifest's hash (note N12). */
export async function assertDatasetHash(dir: string, expected: string): Promise<string> {
  const verify = await verifyManifest(dir);
  if (!verify.ok) throw new Error(`dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  const actual = loadManifest(dir).datasetHash;
  if (actual !== expected) throw new Error(`dataset manifest hash mismatch: loaded ${actual}, expected ${expected}`);
  return actual;
}

const RowsMetaSchema = z.object({
  datasetHash: z.string(),
  sha256: z.string(),
  rows: z.number(),
  dropped: z.number(),
  pastWindowEnd: z.number(),
  start: z.string(),
  end: z.string(),
  intervals: z.array(z.string()),
  symbols: z.array(z.string()),
  scoresOnly: z.boolean(),
  gitCommit: z.string(),
});
export type DxRowsMeta = z.infer<typeof RowsMetaSchema>;

export const rowsMetaPath = (rowsPath: string): string => `${rowsPath}.meta.json`;

export function readRowsMeta(rowsPath: string): DxRowsMeta {
  return RowsMetaSchema.parse(JSON.parse(readFileSync(rowsMetaPath(rowsPath), 'utf8')));
}

/** The rows file a consumer reads must be the one its sidecar describes, built in the expected mode and window. */
export function assertRowsMeta(
  meta: DxRowsMeta,
  expected: { datasetHash: string; sha256: string; scoresOnly: boolean; window?: { start: string; end: string } }
): void {
  const problems: string[] = [];
  if (meta.datasetHash !== expected.datasetHash) problems.push(`datasetHash ${meta.datasetHash}, expected ${expected.datasetHash}`);
  if (meta.sha256 !== expected.sha256) problems.push(`rows sha256 ${meta.sha256}, file has ${expected.sha256}`);
  if (meta.scoresOnly !== expected.scoresOnly) problems.push(`scoresOnly ${meta.scoresOnly}, expected ${expected.scoresOnly}`);
  if (expected.window) {
    const iso = (v: string) => new Date(v).toISOString();
    if (iso(meta.start) !== iso(expected.window.start) || iso(meta.end) !== iso(expected.window.end)) {
      problems.push(`window ${meta.start}..${meta.end}, expected ${expected.window.start}..${expected.window.end}`);
    }
  }
  if (problems.length > 0) throw new Error(`rows meta check failed: ${problems.join('; ')}`);
}

export interface RowsArgs {
  datasetDir: string;
  out: string;
  start: string;
  end: string;
  expectManifestHash: string;
  intervals: string[];
  symbols: string[];
  scoresOnly: boolean;
}

export function parseArgs(argv: string[]): RowsArgs {
  const args: Partial<RowsArgs> & { intervals: string[]; symbols: string[]; scoresOnly: boolean } = {
    intervals: ['1h', '4h'],
    symbols: [...DIRECTION_EXIT_SYMBOLS],
    scoresOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
      return v;
    };
    if (flag === '--dataset-dir') args.datasetDir = value();
    else if (flag === '--out') args.out = value();
    else if (flag === '--start') args.start = new Date(value()).toISOString();
    else if (flag === '--end') args.end = new Date(value()).toISOString();
    else if (flag === '--intervals') args.intervals = value().split(',');
    else if (flag === '--symbols') args.symbols = value().split(',');
    else if (flag === '--expect-manifest-hash') args.expectManifestHash = value();
    else if (flag === '--scores-only') args.scoresOnly = true;
    else throw new Error(`Unknown flag "${flag}"`);
  }
  for (const k of ['datasetDir', 'out', 'start', 'end', 'expectManifestHash'] as const) if (!args[k]) throw new Error(`--${k} is required`);
  return args as RowsArgs;
}

/** Fixed key order so the bytes depend only on the data. */
function toLine(r: DxRow, scoresOnly: boolean): string {
  if (scoresOnly) {
    return JSON.stringify({ symbol: r.symbol, interval: r.interval, tradingStyle: r.style, candleTimestamp: r.t, score: r.score, tier: r.tier });
  }
  return JSON.stringify(r);
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const datasetHash = await assertDatasetHash(args.datasetDir, args.expectManifestHash);
    const lines: string[] = [];
    const byCell: Record<string, { rows: number; dropped: number; pastWindowEnd: number }> = {};
    let dropped = 0;
    let pastWindowEnd = 0;
    for (const cell of DIRECTION_EXIT_CELLS) {
      if (!args.intervals.includes(cell.interval)) continue;
      const key = `${cell.style}|${cell.interval}`;
      byCell[key] = { rows: 0, dropped: 0, pastWindowEnd: 0 };
      for (const symbol of args.symbols) {
        const matrix = loadCellMatrix(args.datasetDir, symbol, cell.interval, cell.style);
        const candles = loadCandles(args.datasetDir, symbol, cell.interval, { allowLockbox: true }).rows;
        if (candles.length !== matrix.timestamps.length) throw new Error(`${symbol} ${cell.interval}: candles and matrix differ in length`);
        const ohlcv: OHLCV[] = candles.map((c) => ({ timestamp: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v }));
        const built = buildDxRows({
          symbol,
          interval: cell.interval,
          style: cell.style,
          horizonBars: cell.horizonBars,
          path: { t: matrix.timestamps, o: candles.map((c) => c.o), h: candles.map((c) => c.h), l: candles.map((c) => c.l), c: matrix.closes },
          names: matrix.names,
          values: matrix.values,
          atr14: atr(ohlcv, DIRECTION_EXIT_ATR_PERIOD),
          window: { start: args.start, end: args.end },
          scoresOnly: args.scoresOnly,
        });
        for (const r of built.rows) lines.push(toLine(r, args.scoresOnly));
        byCell[key].rows += built.rows.length;
        byCell[key].dropped += built.dropped;
        byCell[key].pastWindowEnd += built.pastWindowEnd;
        dropped += built.dropped;
        pastWindowEnd += built.pastWindowEnd;
        console.error(
          `[dx-rows] ${key} ${symbol}: ${built.rows.length} rows, ${built.dropped} dropped, ${built.pastWindowEnd} past the window end`
        );
      }
    }
    const gz = gzipSync(Buffer.from(lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8'));
    const sha256 = createHash('sha256').update(gz).digest('hex');
    writeFileSync(args.out, gz);
    const meta: DxRowsMeta = {
      datasetHash,
      sha256,
      rows: lines.length,
      dropped,
      pastWindowEnd,
      start: args.start,
      end: args.end,
      intervals: args.intervals,
      symbols: args.symbols,
      scoresOnly: args.scoresOnly,
      gitCommit: process.env.GIT_COMMIT ?? 'unknown',
    };
    writeFileSync(rowsMetaPath(args.out), JSON.stringify(meta, null, 2) + '\n');
    console.log(JSON.stringify({ rows: lines.length, dropped, pastWindowEnd, sha256, datasetHash, byCell }));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

if (require.main === module) void main();
