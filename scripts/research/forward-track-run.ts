/**
 * Runs the descriptive forward track record (spec: the header of forward-track.ts). No null, no pass/fail.
 *
 *   GIT_COMMIT=<sha> npx tsx scripts/research/forward-track-run.ts --dataset-dir D --out report.json
 *       [--symbols BTCUSDT,...]
 *
 * Memory: A arrays are built ONE SYMBOL AT A TIME and reduced to the raw.rsi flag column; B keeps only the
 * factor column, timestamps and forward returns of each symbol and drops its matrix.
 */
import { writeFileSync } from 'fs';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { loadSymbolData, symbolForwardReturns } from './factor-ic';
import { reduceToColumn } from './forward-rsi';
import { FORWARD_CELLS } from './forward-test';
import { TRACK_BOOTSTRAP, TRACK_SPAN } from './forward-track';
import {
  directionalACell,
  trackBCell,
  trackPeriods,
  type SymbolSeries,
  type TrackACell,
  type TrackBCell,
  type TrackLabel,
} from './forward-track-stats';
import { loadManifest, verifyManifest } from './load-dataset';
import { SNIPE_TIMEFRAMES } from './snipe';
import { gitCommitFromEnv, parseFlags } from './snipe-cli';
import { buildSymbolArrays, type SnipeSymbolArrays } from './snipe-matrix';
import { cellBit, sliceView } from './snipe-stats';

export interface ForwardTrackArgs {
  datasetDir: string;
  out: string;
  symbols: string[];
}

const FLAGS = ['dataset-dir', 'out', 'symbols'];

export function parseForwardTrackArgs(argv: string[]): ForwardTrackArgs {
  const flags = parseFlags(argv, FLAGS);
  const datasetDir = flags.get('dataset-dir');
  const out = flags.get('out');
  if (!datasetDir) throw new Error('--dataset-dir is required');
  if (!out) throw new Error('--out is required');
  const symbols = flags.get('symbols') ? flags.get('symbols')!.split(',').map((s) => s.trim()) : [...SIGNAL_SYMBOLS];
  if (symbols.length === 0 || symbols.some((s) => s === '')) throw new Error('--symbols is empty');
  return { datasetDir, out, symbols };
}

export interface ForwardTrackRow {
  period: string;
  label: TrackLabel;
  start: string;
  end: string;
  A1: TrackACell;
  A2: TrackACell;
  B: TrackBCell;
}

export interface ForwardTrackReport {
  reportKind: 'forward-track';
  schemaVersion: 1;
  descriptive: true;
  datasetManifestHash: string;
  gitCommit: string;
  computedAt: string;
  span: { dataStart: string; end: string };
  bootstrap: { resamples: number; seed: number };
  symbols: string[];
  rows: ForwardTrackRow[];
}

function f(x: number | null | undefined, digits: number): string {
  return x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(digits);
}

function aText(c: TrackACell): string {
  return `${f(c.excess * 100, 2)} [${f(c.ci[0] * 100, 2)},${f(c.ci[1] * 100, 2)}] n${c.resolved}`;
}

export function formatTable(rows: ForwardTrackRow[]): string[] {
  const lines = ['period   label        A1 excess pts [CI] n          A2 excess pts [CI] n          B IC (t) negSym'];
  for (const r of rows) {
    lines.push(
      `${r.period.padEnd(8)} ${r.label.padEnd(12)} ${aText(r.A1).padEnd(28)} ${aText(r.A2).padEnd(28)} ` +
        `${f(r.B.ic, 4)} (${f(r.B.t, 2)}) ${r.B.negativeSymbols}/${r.B.perSymbol.length} n${r.B.n}`
    );
  }
  return lines;
}

/** A: arrays once per symbol over the span, one symbol at a time, reduced to the raw.rsi flag column. */
export function buildAArrays(
  datasetDir: string,
  symbols: string[],
  startMs: number,
  endMs: number,
  log: (line: string) => void = () => undefined
): SnipeSymbolArrays[] {
  const arrays: SnipeSymbolArrays[] = [];
  for (const symbol of symbols) {
    const full = buildSymbolArrays(datasetDir, symbol, 'scalp', { allowLockbox: true, startMs, endMs });
    const small = reduceToColumn(full, FORWARD_CELLS.A1.column);
    arrays.push(small);
    log(`[forward-track] A ${symbol}: ${small.timestamps.length} bars`);
  }
  return arrays;
}

/** B: factor column, timestamps and perp forward returns (horizon 1, lag 1) once per symbol; the matrix is dropped. */
export function loadBSeries(
  datasetDir: string,
  symbols: string[],
  startMs: number,
  endMs: number,
  log: (line: string) => void = () => undefined
): SymbolSeries[] {
  const cellB = FORWARD_CELLS.B;
  const series: SymbolSeries[] = [];
  for (const symbol of symbols) {
    const data = loadSymbolData(datasetDir, symbol, cellB.interval, { allowLockbox: true, start: startMs, end: endMs });
    const idx = data.matrix.names.indexOf(cellB.column);
    if (idx === -1) throw new Error(`forward-track: ${cellB.column} is not in the ${symbol} ${cellB.interval} matrix`);
    if (!data.matrix.perpCloses.some((c) => Number.isFinite(c))) {
      throw new Error(`forward-track: no perpetual ${cellB.interval} bars for ${symbol}`);
    }
    series.push({
      symbol,
      timestamps: Float64Array.from(data.matrix.timestamps),
      factor: Float64Array.from(data.matrix.values[idx]),
      fwd: symbolForwardReturns(data, cellB.horizon, cellB.executionLag, cellB.returnSeries),
    });
    log(`[forward-track] B ${symbol}: ${data.matrix.timestamps.length} bars`);
  }
  return series;
}

export async function runForwardTrack(
  args: ForwardTrackArgs,
  log: (line: string) => void = console.log
): Promise<ForwardTrackReport> {
  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) throw new Error(`forward-track: dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  const manifestHash = loadManifest(args.datasetDir).datasetHash;

  const startMs = Date.parse(TRACK_SPAN.dataStart);
  const endMs = Date.parse(TRACK_SPAN.end);
  const periods = trackPeriods();
  const maxHoldMs = SNIPE_TIMEFRAMES.scalp.maxHoldMs;

  const column = FORWARD_CELLS.A1.column;
  const arrays = buildAArrays(args.datasetDir, args.symbols, startMs, endMs, log);
  const series = loadBSeries(args.datasetDir, args.symbols, startMs, endMs, log);
  const cellB = FORWARD_CELLS.B;

  const rows: ForwardTrackRow[] = [];
  for (const p of periods) {
    const views = arrays.map((a) => sliceView(a, { startMs: p.startMs, endMs: p.endMs }, maxHoldMs));
    const a1 = directionalACell(views, column, cellBit({ tail: 'bottom', level: 'many' }), FORWARD_CELLS.A1.direction, TRACK_BOOTSTRAP);
    const a2 = directionalACell(views, column, cellBit({ tail: 'top', level: 'many' }), FORWARD_CELLS.A2.direction, TRACK_BOOTSTRAP);
    const b = trackBCell(series, p.startMs, p.endMs, cellB.horizon);
    rows.push({
      period: p.id,
      label: p.label,
      start: new Date(p.startMs).toISOString(),
      end: new Date(p.endMs).toISOString(),
      A1: a1,
      A2: a2,
      B: b,
    });
  }

  const report: ForwardTrackReport = {
    reportKind: 'forward-track',
    schemaVersion: 1,
    descriptive: true,
    datasetManifestHash: manifestHash,
    gitCommit: gitCommitFromEnv(),
    computedAt: new Date().toISOString(),
    span: { dataStart: TRACK_SPAN.dataStart, end: TRACK_SPAN.end },
    bootstrap: { ...TRACK_BOOTSTRAP },
    symbols: args.symbols,
    rows,
  };
  writeFileSync(args.out, JSON.stringify(report, null, 2));
  log(`forward-track DESCRIPTIVE dataset ${manifestHash} commit ${report.gitCommit}`);
  for (const line of formatTable(rows)) log(line);
  return report;
}

if (require.main === module) {
  runForwardTrack(parseForwardTrackArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
