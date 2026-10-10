/**
 * CLI of the live-record study (spec: header of live-record.ts).
 *
 *   npx tsx scripts/research/live-record-run.ts --export <file.jsonl.gz> --out <report.json>
 *     [--expect-sha256 <hex>] [--cutoff-ms <ms>]
 *
 * Reads only the exported file (never a database). The file's sha256 is recorded and, when
 * --expect-sha256 is given, must match. cutoffMs comes from an optional first line
 * {"kind":"live-record-export","cutoffMs":N} of the file, else --cutoff-ms, else null (the
 * exporter prints it on stdout and keeps it out of the file so the hash depends on data only).
 * Versions 4, 7, 8 are analysed per cell; 5, 6 and the 1d cells are counted only.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { defaultCostPercent } from '@/lib/backtest/cost-model';
import { intervalToMs } from '@/lib/intervals';
import { OUTCOME_HORIZON_BARS } from '@/lib/signals/outcome-horizons';
import type { TradingStyle } from '@/lib/models/signal-template';
import {
  LIVE_RECORD_BOOTSTRAP,
  LIVE_RECORD_CELLS,
  LIVE_RECORD_LEDGER,
  LIVE_RECORD_PRIMARY_VERSION,
  LIVE_RECORD_VERDICT_LEVEL,
  LIVE_RECORD_VERSIONS,
} from './live-record';
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

export interface RunArgs {
  exportPath: string;
  outPath: string;
  expectSha256: string | null;
  cutoffMs: number | null;
}

export function parseArgs(argv: string[]): RunArgs {
  let exportPath: string | null = null;
  let outPath: string | null = null;
  let expectSha256: string | null = null;
  let cutoffMs: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
      return v;
    };
    if (flag === '--export') exportPath = value();
    else if (flag === '--out') outPath = value();
    else if (flag === '--expect-sha256') expectSha256 = value().toLowerCase();
    else if (flag === '--cutoff-ms') {
      cutoffMs = Number(value());
      if (!Number.isFinite(cutoffMs)) throw new Error('--cutoff-ms: invalid number');
    } else throw new Error(`Unknown flag "${flag}"`);
  }
  if (!exportPath) throw new Error('--export is required');
  if (!outPath) throw new Error('--out is required');
  return { exportPath, outPath, expectSha256, cutoffMs };
}

export interface ParsedExport {
  rows: LiveRow[];
  /** Rows dropped for a non-finite forward return or timestamp, or a missing field. */
  dropped: number;
  cutoffMs: number | null;
}

/** Parses the decompressed JSONL text; drops (and counts) rows without a finite forward return. */
export function parseExportText(text: string): ParsedExport {
  const rows: LiveRow[] = [];
  let dropped = 0;
  let cutoffMs: number | null = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const o = JSON.parse(line) as Record<string, unknown>;
    if (o.kind === 'live-record-export') {
      if (typeof o.cutoffMs === 'number') cutoffMs = o.cutoffMs;
      continue;
    }
    if (
      typeof o.forwardReturnPercent !== 'number' ||
      !Number.isFinite(o.forwardReturnPercent) ||
      typeof o.candleTimestamp !== 'number' ||
      !Number.isFinite(o.candleTimestamp) ||
      typeof o.configVersion !== 'number' ||
      typeof o.tier !== 'string' ||
      typeof o.score !== 'number'
    ) {
      dropped++;
      continue;
    }
    rows.push(o as unknown as LiveRow);
  }
  return { rows, dropped, cutoffMs };
}

export function verifySha256(bytes: Buffer, expected: string | null): string {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (expected !== null && expected !== actual) {
    throw new Error(`sha256 mismatch: expected ${expected}, file is ${actual}`);
  }
  return actual;
}

export interface CellReport {
  version: number;
  style: string;
  interval: string;
  horizonBars: number;
  costPercent: number;
  rows: number;
  timelinePositions: number;
  spanHorizons: number;
  firstCandleTimestamp: number | null;
  lastCandleTimestamp: number | null;
  measures: CellMeasures;
  intervals: Record<string, MeasureInterval>;
  verdict: VerdictResult | null;
}

function span(rows: LiveRow[]): { positions: number; first: number | null; last: number | null } {
  const ts = new Set<number>();
  let first = Infinity;
  let last = -Infinity;
  for (const r of rows) {
    ts.add(r.candleTimestamp);
    if (r.candleTimestamp < first) first = r.candleTimestamp;
    if (r.candleTimestamp > last) last = r.candleTimestamp;
  }
  return ts.size === 0 ? { positions: 0, first: null, last: null } : { positions: ts.size, first, last };
}

export function analyseCell(
  rows: LiveRow[],
  version: number,
  style: string,
  interval: string,
  resamples: number = LIVE_RECORD_BOOTSTRAP.resamples,
  seed: number = LIVE_RECORD_BOOTSTRAP.seed
): CellReport {
  const horizonBars = OUTCOME_HORIZON_BARS[style as TradingStyle];
  const costPercent = defaultCostPercent(interval);
  const sp = span(rows);
  const spanBars = sp.first === null || sp.last === null ? 0 : (sp.last - sp.first) / intervalToMs(interval) + 1;
  const spanHorizons = spanBars / horizonBars;
  const measures = cellMeasures(rows, costPercent);
  const intervals = blockBootstrap(rows, horizonBars, (rs) => bootstrapMeasures(rs, costPercent), resamples, seed);
  let verdict: VerdictResult | null = null;
  if (version === LIVE_RECORD_PRIMARY_VERSION) {
    const nan = { lo99: NaN, hi99: NaN };
    verdict = verdictOf({
      spanHorizons,
      buyN: measures.buyN,
      sellN: measures.sellN,
      bh: intervals.bh ?? nan,
      s: intervals.s ?? nan,
      net: intervals.net ?? nan,
    });
  }
  return {
    version,
    style,
    interval,
    horizonBars,
    costPercent,
    rows: rows.length,
    timelinePositions: sp.positions,
    spanHorizons,
    firstCandleTimestamp: sp.first,
    lastCandleTimestamp: sp.last,
    measures,
    intervals,
    verdict,
  };
}

/** Row counts per "version|style|interval|tier" for the count-only versions and the 1d cells. */
export function countOnly(rows: LiveRow[]): Record<string, number> {
  const analysed = new Set<number>(LIVE_RECORD_VERSIONS);
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (analysed.has(r.configVersion) && r.interval !== '1d') continue;
    const key = `${r.configVersion}|${r.tradingStyle}|${r.interval}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface LiveRecordReport {
  reportKind: 'live-record';
  exportSha256: string;
  cutoffMs: number | null;
  gitCommit: string | null;
  ledger: number;
  verdictLevel: number;
  bootstrap: { resamples: number; seed: number };
  rowsRead: number;
  rowsDropped: number;
  cells: CellReport[];
  countsOnly: Record<string, number>;
}

export function buildReport(
  parsed: ParsedExport,
  sha256: string,
  cutoffMs: number | null,
  gitCommit: string | null,
  resamples: number = LIVE_RECORD_BOOTSTRAP.resamples,
  seed: number = LIVE_RECORD_BOOTSTRAP.seed
): LiveRecordReport {
  const cells: CellReport[] = [];
  for (const version of LIVE_RECORD_VERSIONS) {
    for (const cell of LIVE_RECORD_CELLS) {
      const rows = parsed.rows.filter(
        (r) => r.configVersion === version && r.tradingStyle === cell.style && r.interval === cell.interval
      );
      cells.push(analyseCell(rows, version, cell.style, cell.interval, resamples, seed));
    }
  }
  return {
    reportKind: 'live-record',
    exportSha256: sha256,
    cutoffMs: parsed.cutoffMs ?? cutoffMs,
    gitCommit,
    ledger: LIVE_RECORD_LEDGER,
    verdictLevel: LIVE_RECORD_VERDICT_LEVEL,
    bootstrap: { resamples, seed },
    rowsRead: parsed.rows.length,
    rowsDropped: parsed.dropped,
    cells,
    countsOnly: countOnly(parsed.rows),
  };
}

const f = (v: number, d = 4): string => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');

/** Compact one-line-per-cell table. */
export function formatTable(report: LiveRecordReport): string {
  const lines = ['ver style/interval        rows   buy  sell      BH [99% CI]            S [99% CI]             N [99% CI]  verdict'];
  for (const c of report.cells) {
    const i = c.intervals;
    const ci = (k: string, d: number): string =>
      i[k] ? `[${f(i[k].lo99, d)}, ${f(i[k].hi99, d)}]` : '[n/a]';
    lines.push(
      `${c.version}   ${(c.style + '/' + c.interval).padEnd(20)} ${String(c.rows).padStart(7)} ${String(c.measures.buyN).padStart(5)} ${String(c.measures.sellN).padStart(5)}  ` +
        `${f(c.measures.bh)} ${ci('bh', 3)}  ${f(c.measures.s)} ${ci('s', 3)}  ${f(c.measures.net)} ${ci('net', 3)}  ${c.verdict ? c.verdict.verdict + (c.verdict.pays && c.verdict.verdict !== 'PAYS' ? ' +PAYS' : '') : '-'}`
    );
  }
  return lines.join('\n');
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    const bytes = readFileSync(args.exportPath);
    const sha256 = verifySha256(bytes, args.expectSha256);
    const parsed = parseExportText(gunzipSync(bytes).toString('utf8'));
    const report = buildReport(parsed, sha256, args.cutoffMs, process.env.GIT_COMMIT ?? null);
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
