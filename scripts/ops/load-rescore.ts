/**
 * Loads the v8 historical re-score (spec: header of scripts/research/v8-rescore.ts) into the two
 * research-only collections the chart's track record reads: SignalRescoreBar (bars, bucketed per
 * symbol, cell and UTC day) and SignalRescoreRun (provenance, pooled verdicts, per-symbol and
 * per-month measures).
 *
 *   npx tsx scripts/ops/load-rescore.ts --rows <v8-rows.jsonl.gz> --report <v8-rescore-report.json>
 *     [--resamples 1000] [--dry-run]
 *
 * Reads SignalOutcome once (an aggregation per cell) for the first live bar of each symbol at the
 * run's configVersion, stored as liveSince: where the chart hands over from the re-score to the live
 * record. Refuses to load unless both files hash to the values recorded in the re-score's RESULT block,
 * every row is a configVersion 8 row of a re-score cell, and every stored tier equals the v8
 * cutoffs applied to its score. Writes nothing else: never GlobalSignal, SignalOutcome or any
 * collection the scheduler, resolver or paper desk reads. A reload of the same run id replaces it:
 * the run document is deleted first (so the route reports "no run" while bars are rewritten) and
 * written last.
 *
 * Per-symbol intervals are 95% moving-block bootstraps (block = horizonBars, seed 13) of the shares
 * right, the balanced hit rate and the net per call, reusing the live-record study's blockBootstrap;
 * an interval is null unless every resample produced a finite value. The pooled figures are copied
 * from the report, never recomputed. Prints one JSON line per symbol-cell and a final summary line.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';

import { SignalRescoreBar } from '@/lib/models/signal-rescore-bar';
import { SignalOutcome, sourceMatch } from '@/lib/models/signal-outcome';
import { SignalRescoreRun } from '@/lib/models/signal-rescore-run';
import { connectDB } from '@/lib/mongodb';
import { TIER_BUY_CUTOFF, TIER_STRONG_CUTOFF } from '@/lib/signals/calibration';
import { monthMeasures, pointMeasures, tierCode } from '@/lib/signals/track-record/measures';
import { trackRunSchema } from '@/lib/signals/track-record/schema';
import {
  TRACK_RECORD_CELLS,
  TRACK_RECORD_RUN_ID,
  type CellTrack,
  type IntervalPair,
  type SymbolTrack,
  type TrackRun,
} from '@/lib/signals/track-record/types';
import type { TradingStyle } from '@/lib/models/signal-template';
import type { SignalTier } from '@/types/signal';

import { parseExportText, verifySha256 } from '../research/live-record-run';
import { blockBootstrap, type LiveRow, type MeasureInterval } from '../research/live-record-stats';
import { V8_RESCORE_CONFIG_VERSION, V8_RESCORE_WINDOW } from '../research/v8-rescore';

/** From the RESULT block of scripts/research/v8-rescore.ts. */
export const RESCORE_ROWS_SHA256 = '2addedf2b2ce8d2e22d04a3f58fb207867f09f9546b25c7ee87e89f7e0967d68';
export const RESCORE_REPORT_SHA256 = '2e19b91553c06f4adcc6f5adfb5d36c9edaaa99075069e99bf5400a040262c74';
/** The cutoffs version 8 ran with (calibration.ts at the time of the re-score). */
export const RESCORE_CUTOFFS = { buy: 28, strong: 36 } as const;
export const DEFAULT_RESAMPLES = 1_000;
export const BOOTSTRAP_SEED = 13;
const INSERT_BATCH = 500;

export interface LoadArgs {
  rowsPath: string;
  reportPath: string;
  resamples: number;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): LoadArgs {
  let rowsPath: string | null = null;
  let reportPath: string | null = null;
  let resamples = DEFAULT_RESAMPLES;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
      return v;
    };
    if (flag === '--rows') rowsPath = value();
    else if (flag === '--report') reportPath = value();
    else if (flag === '--resamples') {
      resamples = Number(value());
      if (!Number.isInteger(resamples) || resamples < 100) throw new Error('--resamples must be an integer >= 100');
    } else if (flag === '--dry-run') dryRun = true;
    else throw new Error(`Unknown flag "${flag}"`);
  }
  if (!rowsPath) throw new Error('--rows is required');
  if (!reportPath) throw new Error('--report is required');
  return { rowsPath, reportPath, resamples, dryRun };
}

/** v8's getTier at the re-score's cutoffs (strict comparisons, as scorer.ts). */
export function tierAtCutoffs(score: number, cutoffs: { buy: number; strong: number }): SignalTier {
  if (score > cutoffs.strong) return 'strong_buy';
  if (score > cutoffs.buy) return 'buy';
  if (score < -cutoffs.strong) return 'strong_sell';
  if (score < -cutoffs.buy) return 'sell';
  return 'neutral';
}

const cellKey = (style: string, interval: string): string => `${style}|${interval}`;
const KNOWN_CELLS = new Set(TRACK_RECORD_CELLS.map((c) => cellKey(c.style, c.interval)));

/** Every row must belong to the run it claims to be; one bad row stops the load. */
export function validateRows(rows: LiveRow[]): void {
  for (const r of rows) {
    if (r.configVersion !== V8_RESCORE_CONFIG_VERSION) {
      throw new Error(`Row with configVersion ${r.configVersion}; the re-score is version ${V8_RESCORE_CONFIG_VERSION}`);
    }
    if (!KNOWN_CELLS.has(cellKey(r.tradingStyle, r.interval))) {
      throw new Error(`Row outside the re-score cells: ${r.tradingStyle} ${r.interval}`);
    }
    const expected = tierAtCutoffs(r.score, RESCORE_CUTOFFS);
    if (r.tier !== expected) {
      throw new Error(`Tier ${r.tier} does not match score ${r.score} at the v8 cutoffs (${expected})`);
    }
  }
}

/** UTC day start of the bar, or UTC month start at 1d (a day bucket would hold one bar). */
export function bucketStartOf(interval: string, t: number): number {
  const d = new Date(t);
  if (interval === '1d') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface BucketDoc {
  runId: string;
  symbol: string;
  interval: string;
  tradingStyle: string;
  bucketStart: number;
  t: number[];
  score: number[];
  tier: number[];
  fwd: number[];
}

/** Buckets one symbol-cell's rows (any order) into per-day documents, bars ascending. */
export function buildBucketDocs(runId: string, rows: LiveRow[]): BucketDoc[] {
  const sorted = [...rows].sort((a, b) => a.candleTimestamp - b.candleTimestamp);
  const docs = new Map<string, BucketDoc>();
  for (const r of sorted) {
    const bucketStart = bucketStartOf(r.interval, r.candleTimestamp);
    const key = `${r.symbol}|${r.tradingStyle}|${r.interval}|${bucketStart}`;
    let doc = docs.get(key);
    if (!doc) {
      doc = {
        runId,
        symbol: r.symbol,
        interval: r.interval,
        tradingStyle: r.tradingStyle,
        bucketStart,
        t: [],
        score: [],
        tier: [],
        fwd: [],
      };
      docs.set(key, doc);
    }
    if (doc.t.length > 0 && doc.t[doc.t.length - 1] === r.candleTimestamp) {
      throw new Error(`Duplicate bar ${r.symbol} ${r.tradingStyle} ${r.interval} ${r.candleTimestamp}`);
    }
    doc.t.push(r.candleTimestamp);
    doc.score.push(r.score);
    doc.tier.push(tierCode(r.tier as SignalTier));
    doc.fwd.push(r.forwardReturnPercent);
  }
  return [...docs.values()];
}

function pairOf(interval: MeasureInterval | undefined, resamples: number): IntervalPair | null {
  if (!interval || interval.finite < resamples) return null;
  return { lo: interval.lo95, hi: interval.hi95 };
}

/** One symbol's year in one cell: point measures, 95% bootstrap intervals and months. */
export function symbolTrack(
  rows: LiveRow[],
  costPercent: number,
  horizonBars: number,
  resamples: number,
  liveSince: number | null = null,
  seed: number = BOOTSTRAP_SEED
): SymbolTrack {
  if (rows.length === 0) throw new Error('symbolTrack needs rows');
  let first = Infinity;
  let last = -Infinity;
  for (const r of rows) {
    if (r.candleTimestamp < first) first = r.candleTimestamp;
    if (r.candleTimestamp > last) last = r.candleTimestamp;
  }
  const boot = blockBootstrap(
    rows,
    horizonBars,
    (resampled) => {
      const m = pointMeasures(resampled, costPercent);
      return { right: m.right ?? NaN, bh: m.bh ?? NaN, net: m.net ?? NaN };
    },
    resamples,
    seed
  );
  return {
    symbol: rows[0].symbol,
    first,
    last,
    liveSince,
    measures: pointMeasures(rows, costPercent),
    intervals: {
      right: pairOf(boot.right, resamples),
      bh: pairOf(boot.bh, resamples),
      net: pairOf(boot.net, resamples),
    },
    months: monthMeasures(rows, costPercent),
  };
}

const levelInterval = z.object({ loLevel: z.number(), hiLevel: z.number() });

/** The fields the loader copies out of the re-score report; anything missing stops the load. */
export const reportSchema = z.object({
  reportKind: z.literal('v8-rescore'),
  rowsSha256: z.string(),
  gitCommit: z.string(),
  configVersion: z.number(),
  verdictLevel: z.number(),
  cells: z.array(
    z.object({
      style: z.string(),
      interval: z.string(),
      horizonBars: z.number(),
      costPercent: z.number(),
      rows: z.number(),
      measures: z.object({
        buyN: z.number(),
        sellN: z.number(),
        bh: z.number(),
        net: z.number(),
        spearman: z.number(),
      }),
      intervals: z.object({ bh: levelInterval, net: levelInterval }),
      verdict: z.object({ verdict: z.string(), level: z.number() }),
      parity: z.object({
        matched: z.number(),
        sameTierShare: z.number().nullable(),
        scoreCorrelation: z.number().nullable(),
      }),
    })
  ),
});

export type RescoreReport = z.infer<typeof reportSchema>;

/** The cell's pooled verdict and parity, copied from the report, with this run's symbols. */
export function cellTrackFromReport(
  cell: RescoreReport['cells'][number],
  symbols: SymbolTrack[]
): CellTrack {
  const known = TRACK_RECORD_CELLS.find((c) => c.style === cell.style && c.interval === cell.interval);
  if (!known) throw new Error(`Report cell outside the re-score cells: ${cell.style} ${cell.interval}`);
  if (known.horizonBars !== cell.horizonBars) {
    throw new Error(`Horizon mismatch for ${cell.style} ${cell.interval}: ${cell.horizonBars} vs ${known.horizonBars}`);
  }
  return {
    style: known.style as TradingStyle,
    interval: cell.interval,
    horizonBars: cell.horizonBars,
    costPercent: cell.costPercent,
    pooled: {
      rows: cell.rows,
      buyN: cell.measures.buyN,
      sellN: cell.measures.sellN,
      bh: cell.measures.bh,
      bhLo: cell.intervals.bh.loLevel,
      bhHi: cell.intervals.bh.hiLevel,
      net: cell.measures.net,
      netLo: cell.intervals.net.loLevel,
      netHi: cell.intervals.net.hiLevel,
      spearman: cell.measures.spearman,
      level: cell.verdict.level,
      verdict: cell.verdict.verdict,
    },
    parity: {
      matched: cell.parity.matched,
      sameTierShare: cell.parity.sameTierShare,
      scoreCorrelation: cell.parity.scoreCorrelation,
    },
    symbols,
  };
}

/** Groups rows by "style|interval" then symbol. */
export function groupRows(rows: LiveRow[]): Map<string, Map<string, LiveRow[]>> {
  const out = new Map<string, Map<string, LiveRow[]>>();
  for (const r of rows) {
    const key = cellKey(r.tradingStyle, r.interval);
    let bySymbol = out.get(key);
    if (!bySymbol) {
      bySymbol = new Map();
      out.set(key, bySymbol);
    }
    const list = bySymbol.get(r.symbol);
    if (list) list.push(r);
    else bySymbol.set(r.symbol, [r]);
  }
  return out;
}

/** "style|interval" -> symbol -> first live bar at the run's configVersion. */
export type LiveSinceMap = Map<string, Map<string, number>>;

export interface BuiltRun {
  run: TrackRun;
  buckets: BucketDoc[];
}

/** Everything the load writes, built in memory; `log` receives one line per symbol-cell. */
export function buildRun(
  rows: LiveRow[],
  report: RescoreReport,
  resamples: number,
  reportSha256: string,
  liveSince: LiveSinceMap = new Map(),
  log: (line: Record<string, unknown>) => void = () => {}
): BuiltRun {
  validateRows(rows);
  if (report.configVersion !== V8_RESCORE_CONFIG_VERSION) {
    throw new Error(`Report is configVersion ${report.configVersion}`);
  }
  const groups = groupRows(rows);
  const buckets: BucketDoc[] = [];
  const cells: CellTrack[] = [];
  for (const reportCell of report.cells) {
    const key = cellKey(reportCell.style, reportCell.interval);
    const bySymbol = groups.get(key) ?? new Map<string, LiveRow[]>();
    const liveByCell = liveSince.get(key);
    const symbols: SymbolTrack[] = [];
    for (const symbol of [...bySymbol.keys()].sort()) {
      const symbolRows = bySymbol.get(symbol) as LiveRow[];
      const started = Date.now();
      const since = liveByCell?.get(symbol) ?? null;
      symbols.push(symbolTrack(symbolRows, reportCell.costPercent, reportCell.horizonBars, resamples, since));
      const docs = buildBucketDocs(TRACK_RECORD_RUN_ID, symbolRows);
      buckets.push(...docs);
      log({ cell: key, symbol, rows: symbolRows.length, buckets: docs.length, liveSince: since, ms: Date.now() - started });
    }
    cells.push(cellTrackFromReport(reportCell, symbols));
  }
  const run: TrackRun = {
    runId: TRACK_RECORD_RUN_ID,
    configVersion: report.configVersion,
    windowStart: V8_RESCORE_WINDOW.start,
    windowEnd: V8_RESCORE_WINDOW.end,
    cutoffs: { ...RESCORE_CUTOFFS },
    rowsSha256: report.rowsSha256,
    reportSha256,
    gitCommit: report.gitCommit,
    resamples,
    seed: BOOTSTRAP_SEED,
    loadedAt: new Date().toISOString(),
    cells,
  };
  return { run: trackRunSchema.parse(run) as TrackRun, buckets };
}

interface LiveSinceGroup {
  _id: { tradingStyle: string; interval: string; symbol: string };
  since: number;
}

/**
 * First live bar per symbol at the run's configVersion, per re-score cell: one aggregation per cell
 * over SignalOutcome (read only). A scan of the cell's whole year, which is why it runs here, once,
 * and not in a request.
 */
async function readLiveSince(configVersion: number): Promise<LiveSinceMap> {
  const out: LiveSinceMap = new Map();
  for (const cell of TRACK_RECORD_CELLS) {
    const groups: LiveSinceGroup[] = await SignalOutcome.aggregate([
      { $match: { tradingStyle: cell.style, interval: cell.interval, configVersion, ...sourceMatch('composite') } },
      {
        $group: {
          _id: { tradingStyle: '$tradingStyle', interval: '$interval', symbol: '$symbol' },
          since: { $min: '$candleTimestamp' },
        },
      },
    ]);
    const bySymbol = new Map<string, number>();
    for (const g of groups) bySymbol.set(g._id.symbol, g.since);
    out.set(cellKey(cell.style, cell.interval), bySymbol);
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (RESCORE_CUTOFFS.buy !== TIER_BUY_CUTOFF || RESCORE_CUTOFFS.strong !== TIER_STRONG_CUTOFF) {
      console.log(
        JSON.stringify({ note: 'live cutoffs differ from the re-score cutoffs; the run keeps its own', live: [TIER_BUY_CUTOFF, TIER_STRONG_CUTOFF] })
      );
    }
    const rowBytes = readFileSync(args.rowsPath);
    verifySha256(rowBytes, RESCORE_ROWS_SHA256);
    const reportBytes = readFileSync(args.reportPath);
    const reportSha256 = verifySha256(reportBytes, RESCORE_REPORT_SHA256);
    const report = reportSchema.parse(JSON.parse(reportBytes.toString('utf8')));
    if (report.rowsSha256 !== RESCORE_ROWS_SHA256) throw new Error('Report was built from a different rows file');

    const parsed = parseExportText(gunzipSync(rowBytes).toString('utf8'));
    if (parsed.dropped > 0) throw new Error(`${parsed.dropped} rows without a finite outcome; the re-score file has none`);

    await connectDB();
    const liveSince = await readLiveSince(report.configVersion);
    const { run, buckets } = buildRun(parsed.rows, report, args.resamples, reportSha256, liveSince, (line) =>
      console.log(JSON.stringify(line))
    );
    const bars = buckets.reduce((n, b) => n + b.t.length, 0);
    if (bars !== parsed.rows.length) throw new Error(`Bucketed ${bars} bars from ${parsed.rows.length} rows`);

    if (args.dryRun) {
      console.log(JSON.stringify({ dryRun: true, runId: run.runId, rows: parsed.rows.length, buckets: buckets.length }));
      process.exit(0);
    }

    await SignalRescoreBar.createIndexes();
    await SignalRescoreRun.createIndexes();
    await SignalRescoreRun.deleteOne({ runId: run.runId });
    const removed = await SignalRescoreBar.deleteMany({ runId: run.runId });
    for (let i = 0; i < buckets.length; i += INSERT_BATCH) {
      await SignalRescoreBar.insertMany(buckets.slice(i, i + INSERT_BATCH), { ordered: true });
    }
    await SignalRescoreRun.create({ ...run, loadedAt: new Date(run.loadedAt) });
    const stored = await SignalRescoreBar.countDocuments({ runId: run.runId });
    if (stored !== buckets.length) throw new Error(`Stored ${stored} buckets, built ${buckets.length}`);

    console.log(
      JSON.stringify({
        runId: run.runId,
        rows: parsed.rows.length,
        buckets: buckets.length,
        replacedBuckets: removed.deletedCount,
        cells: run.cells.map((c) => ({ cell: cellKey(c.style, c.interval), symbols: c.symbols.length })),
      })
    );
    process.exit(0);
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
