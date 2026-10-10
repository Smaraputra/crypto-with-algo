/**
 * Judges the v8 historical re-score (spec: header of scripts/research/v8-rescore.ts).
 *
 *   npx tsx scripts/research/v8-rescore-run.ts --rows <rows.jsonl.gz> --live-export <live-outcomes.jsonl.gz>
 *     --out <report.json> [--expect-sha256 <hex>]
 *
 * Reads only the two files. Measures, bootstrap and verdict logic are live-record-stats.ts, reused.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { defaultCostPercent } from '@/lib/backtest/cost-model';
import { intervalToMs } from '@/lib/intervals';
import { LIVE_RECORD_BOOTSTRAP } from './live-record';
import { parseExportText, verifySha256 } from './live-record-run';
import {
  blockBootstrap,
  bootstrapMeasures,
  cellMeasures,
  verdictOf,
  type CellMeasures,
  type LiveRow,
  type MeasureInterval,
  type VerdictResult,
} from './live-record-stats';
import {
  V8_RESCORE_CELLS,
  V8_RESCORE_CONFIG_VERSION,
  V8_RESCORE_LEDGER,
  V8_RESCORE_VERDICT_LEVEL,
} from './v8-rescore';

export interface RunArgs {
  rowsPath: string;
  liveExportPath: string;
  outPath: string;
  expectSha256: string | null;
}

export function parseArgs(argv: string[]): RunArgs {
  let rowsPath: string | null = null;
  let liveExportPath: string | null = null;
  let outPath: string | null = null;
  let expectSha256: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
      return v;
    };
    if (flag === '--rows') rowsPath = value();
    else if (flag === '--live-export') liveExportPath = value();
    else if (flag === '--out') outPath = value();
    else if (flag === '--expect-sha256') expectSha256 = value().toLowerCase();
    else throw new Error(`Unknown flag "${flag}"`);
  }
  if (!rowsPath) throw new Error('--rows is required');
  if (!liveExportPath) throw new Error('--live-export is required');
  if (!outPath) throw new Error('--out is required');
  return { rowsPath, liveExportPath, outPath, expectSha256 };
}

export interface ParityReport {
  matched: number;
  rescoredRows: number;
  liveRows: number;
  sameTierShare: number;
  meanAbsScoreDiff: number;
  maxAbsScoreDiff: number;
  scoreCorrelation: number;
}

const keyOf = (r: Pick<LiveRow, 'symbol' | 'interval' | 'tradingStyle' | 'candleTimestamp'>): string =>
  `${r.symbol}|${r.interval}|${r.tradingStyle}|${r.candleTimestamp}`;

export function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return NaN;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy);
}

/** Joins re-scored rows to live rows on (symbol, interval, tradingStyle, candleTimestamp); both inputs are one cell's rows. */
export function parityOf(rescored: LiveRow[], live: LiveRow[]): ParityReport {
  const liveByKey = new Map<string, LiveRow>();
  for (const r of live) liveByKey.set(keyOf(r), r);
  const a: number[] = [];
  const b: number[] = [];
  let same = 0;
  let sumAbs = 0;
  let maxAbs = 0;
  for (const r of rescored) {
    const l = liveByKey.get(keyOf(r));
    if (!l) continue;
    a.push(r.score);
    b.push(l.score);
    if (r.tier === l.tier) same++;
    const d = Math.abs(r.score - l.score);
    sumAbs += d;
    if (d > maxAbs) maxAbs = d;
  }
  const n = a.length;
  return {
    matched: n,
    rescoredRows: rescored.length,
    liveRows: live.length,
    sameTierShare: n > 0 ? same / n : NaN,
    meanAbsScoreDiff: n > 0 ? sumAbs / n : NaN,
    maxAbsScoreDiff: n > 0 ? maxAbs : NaN,
    scoreCorrelation: pearson(a, b),
  };
}

export interface RescoreCellReport {
  style: string;
  interval: string;
  horizonBars: number;
  costPercent: number;
  rows: number;
  timelinePositions: number;
  spanHorizons: number;
  measures: CellMeasures;
  intervals: Record<string, MeasureInterval>;
  verdict: VerdictResult;
  parity: ParityReport;
}

export function analyseRescoreCell(
  rows: LiveRow[],
  liveRows: LiveRow[],
  cell: { style: string; interval: string; horizonBars: number },
  resamples: number = LIVE_RECORD_BOOTSTRAP.resamples,
  seed: number = LIVE_RECORD_BOOTSTRAP.seed,
  level: number = V8_RESCORE_VERDICT_LEVEL
): RescoreCellReport {
  const costPercent = defaultCostPercent(cell.interval);
  const ts = new Set<number>();
  let first = Infinity;
  let last = -Infinity;
  for (const r of rows) {
    ts.add(r.candleTimestamp);
    if (r.candleTimestamp < first) first = r.candleTimestamp;
    if (r.candleTimestamp > last) last = r.candleTimestamp;
  }
  const spanBars = ts.size === 0 ? 0 : (last - first) / intervalToMs(cell.interval) + 1;
  const spanHorizons = spanBars / cell.horizonBars;
  const measures = cellMeasures(rows, costPercent);
  const intervals = blockBootstrap(
    rows,
    cell.horizonBars,
    (rs) => bootstrapMeasures(rs, costPercent),
    resamples,
    seed,
    level
  );
  const at = (k: string): { lo99: number; hi99: number } => {
    const iv = intervals[k];
    return iv && iv.loLevel !== undefined && iv.hiLevel !== undefined
      ? { lo99: iv.loLevel, hi99: iv.hiLevel }
      : { lo99: NaN, hi99: NaN };
  };
  const verdict = verdictOf(
    { spanHorizons, buyN: measures.buyN, sellN: measures.sellN, bh: at('bh'), s: at('s'), net: at('net') },
    level
  );
  return {
    style: cell.style,
    interval: cell.interval,
    horizonBars: cell.horizonBars,
    costPercent,
    rows: rows.length,
    timelinePositions: ts.size,
    spanHorizons,
    measures,
    intervals,
    verdict,
    parity: parityOf(rows, liveRows),
  };
}

export interface RescoreReport {
  reportKind: 'v8-rescore';
  rowsSha256: string;
  liveExportSha256: string;
  gitCommit: string | null;
  ledger: number;
  configVersion: number;
  verdictLevel: number;
  bootstrap: { resamples: number; seed: number };
  rowsRead: number;
  rowsDropped: number;
  cells: RescoreCellReport[];
  parity: Record<string, ParityReport>;
}

export function buildReport(
  rows: LiveRow[],
  rowsDropped: number,
  liveRows: LiveRow[],
  rowsSha256: string,
  liveExportSha256: string,
  gitCommit: string | null,
  resamples: number = LIVE_RECORD_BOOTSTRAP.resamples,
  seed: number = LIVE_RECORD_BOOTSTRAP.seed
): RescoreReport {
  const cells: RescoreCellReport[] = [];
  const parity: Record<string, ParityReport> = {};
  for (const cell of V8_RESCORE_CELLS) {
    const cellRows = rows.filter((r) => r.tradingStyle === cell.style && r.interval === cell.interval);
    const cellLive = liveRows.filter(
      (r) =>
        r.configVersion === V8_RESCORE_CONFIG_VERSION && r.tradingStyle === cell.style && r.interval === cell.interval
    );
    const report = analyseRescoreCell(cellRows, cellLive, cell, resamples, seed);
    cells.push(report);
    parity[`${cell.style}|${cell.interval}`] = report.parity;
  }
  return {
    reportKind: 'v8-rescore',
    rowsSha256,
    liveExportSha256,
    gitCommit,
    ledger: V8_RESCORE_LEDGER,
    configVersion: V8_RESCORE_CONFIG_VERSION,
    verdictLevel: V8_RESCORE_VERDICT_LEVEL,
    bootstrap: { resamples, seed },
    rowsRead: rows.length,
    rowsDropped,
    cells,
    parity,
  };
}

const f = (v: number, d = 4): string => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');

export function formatTable(report: RescoreReport): string {
  const lines = ['style/interval         rows   buy  sell      BH      S      N   verdict | parity: n sameTier mean|d| max|d| r'];
  for (const c of report.cells) {
    const p = c.parity;
    lines.push(
      `${(c.style + '/' + c.interval).padEnd(20)} ${String(c.rows).padStart(7)} ${String(c.measures.buyN).padStart(5)} ${String(c.measures.sellN).padStart(5)}  ` +
        `${f(c.measures.bh)} ${f(c.measures.s)} ${f(c.measures.net)}  ${c.verdict.verdict}${c.verdict.pays && c.verdict.verdict !== 'PAYS' ? ' +PAYS' : ''} | ` +
        `${p.matched} ${f(p.sameTierShare, 3)} ${f(p.meanAbsScoreDiff, 2)} ${f(p.maxAbsScoreDiff, 2)} ${f(p.scoreCorrelation, 3)}`
    );
  }
  return lines.join('\n');
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    const bytes = readFileSync(args.rowsPath);
    const rowsSha = verifySha256(bytes, args.expectSha256);
    const mine = parseExportText(gunzipSync(bytes).toString('utf8'));
    const liveBytes = readFileSync(args.liveExportPath);
    const liveSha = createHash('sha256').update(liveBytes).digest('hex');
    const live = parseExportText(gunzipSync(liveBytes).toString('utf8'));
    const report = buildReport(mine.rows, mine.dropped, live.rows, rowsSha, liveSha, process.env.GIT_COMMIT ?? null);
    writeFileSync(args.outPath, JSON.stringify(report, null, 2) + '\n');
    console.log(formatTable(report));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
