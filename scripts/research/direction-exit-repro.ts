/**
 * The study's two checks before any develop number (spec REPRODUCTION CHECK and note N6):
 *   repro:  npx tsx scripts/research/direction-exit-repro.ts repro --mine <scores-only rows.jsonl.gz> \
 *             --reference <v8-rows.jsonl.gz>
 *   parity: npx tsx scripts/research/direction-exit-repro.ts parity --dataset-dir <dir> --symbol BTCUSDT \
 *             --interval 1h --start 2024-11-01 --end 2024-12-31
 * Both compare scores and tiers only, never a return. Exit 0 on pass, 2 on fail.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { mapToSnapshotInterval } from '@/lib/backtest/snapshot-series';
import { prepareBacktest, runOptimizedBacktest } from '@/lib/backtest/optimized-engine';
import type { Strategy } from '@/lib/backtest/strategy';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtest/types';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import { DIRECTION_EXIT_CELLS, DIRECTION_EXIT_REFERENCE_ROWS_SHA256, DIRECTION_EXIT_REPRODUCTION } from './direction-exit';
import { parseExportText, verifySha256 } from './live-record-run';
import { CATEGORIES } from './direction-exit-rows';
import { loadCellMatrix } from './v8-rescore-build';
import { loadSymbolInputs } from './strategy-harness';

type ScoreRow = { symbol: string; interval: string; tradingStyle: string; candleTimestamp: number; score: number; tier: string };

export interface ReproResult {
  interval: string;
  referenceRows: number;
  matched: number;
  sameTierShare: number;
  scoreCorrelation: number;
  pass: boolean;
  reasons: string[];
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return NaN;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

export function compareToReference(mine: ScoreRow[], reference: ScoreRow[], interval: string, window: { start: number; end: number }): ReproResult {
  const style = DIRECTION_EXIT_CELLS.find((c) => c.interval === interval)?.style;
  const keep = (r: ScoreRow) => r.interval === interval && r.tradingStyle === style && r.candleTimestamp >= window.start && r.candleTimestamp <= window.end;
  const mineByKey = new Map(mine.filter(keep).map((r) => [`${r.symbol}|${r.candleTimestamp}`, r]));
  const ref = reference.filter(keep);
  const a: number[] = [];
  const b: number[] = [];
  let same = 0;
  for (const r of ref) {
    const m = mineByKey.get(`${r.symbol}|${r.candleTimestamp}`);
    if (!m) continue;
    a.push(m.score);
    b.push(r.score);
    if (m.tier === r.tier) same++;
  }
  const matched = a.length;
  const sameTierShare = matched > 0 ? same / matched : 0;
  const scoreCorrelation = pearson(a, b);
  const reasons: string[] = [];
  if (matched < 0.9 * ref.length) reasons.push(`matched ${matched} of ${ref.length} reference rows`);
  if (!(sameTierShare >= DIRECTION_EXIT_REPRODUCTION.minSameTierShare)) reasons.push(`same tier ${sameTierShare}`);
  if (!(scoreCorrelation >= DIRECTION_EXIT_REPRODUCTION.minScoreCorrelation)) reasons.push(`correlation ${scoreCorrelation}`);
  return { interval, referenceRows: ref.length, matched, sameTierShare, scoreCorrelation, pass: reasons.length === 0, reasons };
}

export function componentParity(matrixCats: Record<string, ArrayLike<number>>, componentScores: Record<string, ArrayLike<number>>) {
  let compared = 0;
  let maxAbsDiff = 0;
  for (const [cat, mineValues] of Object.entries(matrixCats)) {
    const theirs = componentScores[cat];
    if (!theirs) continue;
    const n = Math.min(mineValues.length, theirs.length);
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(mineValues[i]) || !Number.isFinite(theirs[i])) continue;
      compared++;
      maxAbsDiff = Math.max(maxAbsDiff, Math.abs(mineValues[i] - theirs[i]));
    }
  }
  return { compared, maxAbsDiff, pass: compared >= 1_000 && maxAbsDiff <= 1e-6 };
}

function readRows(path: string): ScoreRow[] {
  return readFileSync(path).length > 0
    ? (gunzipSync(readFileSync(path)).toString('utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) as ScoreRow[])
    : [];
}

function flagValues(argv: string[], required: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const v = argv[++i];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument "${flag}"`);
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    out[flag.slice(2)] = v;
  }
  for (const k of required) if (!out[k]) throw new Error(`--${k} is required`);
  return out;
}

function runRepro(argv: string[]): boolean {
  const a = flagValues(argv, ['mine', 'reference']);
  const refBytes = readFileSync(a.reference);
  verifySha256(refBytes, DIRECTION_EXIT_REFERENCE_ROWS_SHA256);
  const reference = parseExportText(gunzipSync(refBytes).toString('utf8')).rows as unknown as ScoreRow[];
  const mine = readRows(a.mine);
  const window = { start: Date.parse('2025-10-01T00:00:00.000Z'), end: Date.parse('2026-10-09T23:59:59.999Z') };
  let ok = true;
  for (const interval of ['1h', '4h']) {
    const r = compareToReference(mine, reference, interval, window);
    console.log(JSON.stringify(r));
    if (!r.pass) ok = false;
  }
  return ok;
}

function runParity(argv: string[]): boolean {
  const a = flagValues(argv, ['dataset-dir', 'symbol', 'interval', 'start', 'end']);
  const dir = a['dataset-dir'];
  const symbol = a.symbol;
  const interval = a.interval;
  const start = Date.parse(a.start);
  const end = Date.parse(a.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('--start and --end must be dates');
  const style = DIRECTION_EXIT_CELLS.find((c) => c.interval === interval)!.style;

  const matrix = loadCellMatrix(dir, symbol, interval, style);

  // Full candle series (no start filter), as loadCellMatrix uses, so indicator warm-up is identical.
  const inputs = loadSymbolInputs(dir, symbol, interval, style, mapToSnapshotInterval(interval), null, null, { allowLockbox: true, end });
  const catScores = new Map<string, Record<string, number>>();
  const probe: Strategy = {
    name: 'direction-exit-component-probe',
    decideEntry(ctx) {
      const byCat: Record<string, number> = {};
      for (const c of ctx.components ?? []) byCat[c.category] = c.signals.length > 0 ? c.score : NaN;
      catScores.set(String(ctx.candles[ctx.bar].timestamp), byCat);
      return null;
    },
    decideExit: () => false,
  };
  const prepared = prepareBacktest(inputs.candles, symbol, interval, getStyleConfig(style).config, inputs.snapshots, inputs.htfInput, inputs.researchRows, inputs.lsRows1h);
  const config = { ...DEFAULT_BACKTEST_CONFIG, weights: DEFAULT_TEMPLATE_WEIGHTS[style] };
  runOptimizedBacktest(prepared, config, symbol, interval, undefined, probe);

  const matrixCats: Record<string, number[]> = {};
  const componentScores: Record<string, number[]> = {};
  for (const cat of CATEGORIES) {
    matrixCats[cat] = [];
    componentScores[cat] = [];
    const col = matrix.values[matrix.names.indexOf(`cat.${cat}`)];
    if (!col) throw new Error(`matrix has no cat.${cat} column`);
    for (let i = 0; i < matrix.timestamps.length; i++) {
      const t = matrix.timestamps[i];
      if (t < start || t > end) continue;
      matrixCats[cat].push(col[i]);
      componentScores[cat].push(catScores.get(String(t))?.[cat] ?? NaN);
    }
  }
  const result = componentParity(matrixCats, componentScores);
  console.log(JSON.stringify({ symbol, interval, ...result }));
  return result.pass;
}

function main(): void {
  try {
    const [mode, ...rest] = process.argv.slice(2);
    let ok: boolean;
    if (mode === 'repro') ok = runRepro(rest);
    else if (mode === 'parity') ok = runParity(rest);
    else throw new Error('usage: direction-exit-repro.ts <repro|parity> ...');
    process.exit(ok ? 0 : 2);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

if (require.main === module) main();
