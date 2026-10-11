/**
 * Selection and verdict judge of the direction-exit study. `select` picks the develop-window parameters from the
 * --fixed-eval reports; `verdict` judges every confirmation report against the locked VERDICT rules in
 * direction-exit.ts (never tuned on the confirmation window).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { bootstrapCi, meanOf } from '@/lib/stats/block-bootstrap';
import { deflatedSharpe, perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import type { CandleRow } from './dataset-format';
import {
  DIRECTION_EXIT_BOOTSTRAP,
  DIRECTION_EXIT_CELLS,
  DIRECTION_EXIT_CONFIRM_PARTS,
  DIRECTION_EXIT_LEDGER_AFTER,
  DIRECTION_EXIT_MIN_D2_COVERAGE,
  DIRECTION_EXIT_VERDICT_LEVEL,
  type DirectionExitSelection,
} from './direction-exit';
import { loadCandles } from './load-dataset';

export interface DxTrade {
  symbol: string;
  entryTime: number;
  exitTime: number;
  side: 'long' | 'short';
  pnlPercent: number;
  exitReason: string;
}

export interface Verdict {
  config: string;
  pass: boolean;
  failed: string[];
  expectancy: number | null;
  bonferroniLow: number | null;
  parts: Array<{ part: string; n: number; expectancy: number | null }>;
  dsr: number | null;
  reported: Record<string, number | null>;
}

const TradeSchema = z.object({
  entryTime: z.number(),
  exitTime: z.number(),
  side: z.enum(['long', 'short']),
  pnlPercent: z.number(),
  exitReason: z.string(),
});
const ReportSchema = z.object({
  perSymbol: z.array(
    z.object({ symbol: z.string(), windows: z.array(z.object({ trades: z.array(TradeSchema).default([]) })) })
  ),
  gates: z.array(z.object({ name: z.string(), pass: z.boolean() })).default([]),
});

export function tradesOf(report: unknown): DxTrade[] {
  const r = ReportSchema.parse(report);
  return r.perSymbol
    .flatMap((s) => s.windows.flatMap((w) => w.trades.map((t) => ({ symbol: s.symbol, ...t }))))
    .sort((a, b) => a.exitTime - b.exitTime);
}

export function pickBest(
  runs: Array<{ key: string; expectancy: number | null; trades: number; coverage?: number }>,
  opts: { minCoverage?: number }
): string {
  const ok = runs.filter(
    (r) =>
      r.expectancy !== null &&
      r.trades >= 100 &&
      (opts.minCoverage === undefined || (r.coverage ?? 0) >= opts.minCoverage)
  );
  if (ok.length === 0) throw new Error('pickBest: no run qualifies');
  const order = (a: (typeof ok)[number], b: (typeof ok)[number]) =>
    (b.expectancy as number) - (a.expectancy as number) ||
    (b.coverage ?? 0) - (a.coverage ?? 0) ||
    runs.indexOf(a) - runs.indexOf(b);
  return [...ok].sort(order)[0].key;
}

function moments(x: number[]): { skewness: number; kurtosis: number } {
  const n = x.length;
  const m = meanOf(x);
  const m2 = x.reduce((s, v) => s + (v - m) ** 2, 0) / n;
  const m3 = x.reduce((s, v) => s + (v - m) ** 3, 0) / n;
  const m4 = x.reduce((s, v) => s + (v - m) ** 4, 0) / n;
  // Raw fourth moment, as deflated-sharpe.ts expects (not excess).
  return m2 > 0 ? { skewness: m3 / m2 ** 1.5, kurtosis: m4 / m2 ** 2 } : { skewness: 0, kurtosis: 3 };
}

/**
 * t of the slope in an OLS regression of y on x with an intercept, standard error from a Newey-West (Bartlett)
 * sandwich at the given lag. Null when x is constant or the variance estimate is not positive.
 */
export function neweyWestT(x: number[], y: number[], lag: number): number | null {
  const n = x.length;
  if (n < 3 || y.length !== n) return null;
  const xm = meanOf(x);
  const ym = meanOf(y);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - xm) ** 2;
    sxy += (x[i] - xm) * (y[i] - ym);
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  const u = x.map((xi, i) => (xi - xm) * (y[i] - ym - b * (xi - xm)));
  let s = u.reduce((a, v) => a + v * v, 0);
  const L = Math.min(Math.max(0, Math.floor(lag)), n - 1);
  for (let l = 1; l <= L; l++) {
    let g = 0;
    for (let i = l; i < n; i++) g += u[i] * u[i - l];
    s += 2 * (1 - l / (L + 1)) * g;
  }
  const variance = s / sxx ** 2;
  if (!(variance > 0)) return null;
  return b / Math.sqrt(variance);
}

/** Anatolyev-Gerko style statistic as pre-registered: the mean of the signed returns over its standard error. */
export function anatolyevGerko(signedReturns: number[]): number | null {
  const n = signedReturns.length;
  if (n < 2) return null;
  const m = meanOf(signedReturns);
  const v = signedReturns.reduce((s, r) => s + (r - m) ** 2, 0) / (n - 1);
  if (!(v > 0)) return null;
  return m / Math.sqrt(v / n);
}

/**
 * Mean over trades of (gross price move) / (MFE), in the trade's direction. Entry is the open of the bar at
 * entryTime, MFE uses the highs and lows from the entry bar through the exit bar, the exit price is the close of
 * the exit bar. Trades with MFE <= 0 or without candles are skipped.
 */
export function mfeCapture(trades: DxTrade[], candles: Record<string, CandleRow[]>): number | null {
  const caps: number[] = [];
  for (const t of trades) {
    const rows = candles[t.symbol];
    if (!rows) continue;
    const entryBar = rows.find((c) => c.t === t.entryTime);
    if (!entryBar) continue;
    const span = rows.filter((c) => c.t >= t.entryTime && c.t <= t.exitTime);
    if (span.length === 0) continue;
    const dir = t.side === 'long' ? 1 : -1;
    const entry = entryBar.o;
    const best = dir === 1 ? Math.max(...span.map((c) => c.h)) : Math.min(...span.map((c) => c.l));
    const mfe = (dir * (best - entry)) / entry;
    if (!(mfe > 0)) continue;
    const exitPrice = span[span.length - 1].c;
    caps.push((dir * (exitPrice - entry)) / entry / mfe);
  }
  return caps.length ? meanOf(caps) : null;
}

export function judgeConfiguration(input: {
  config: string;
  report: unknown;
  varianceOfTrialSharpes: number;
  numTrials: number;
  horizonBars?: number;
  /** Exit mode 1 to 4, for the protective-stop count. */
  exit?: number;
  candles?: Record<string, CandleRow[]>;
}): Verdict {
  const parsed = ReportSchema.parse(input.report);
  const trades = tradesOf(input.report);
  const pnls = trades.map((t) => t.pnlPercent);
  const horizon = input.horizonBars ?? 24;
  const failed = parsed.gates
    .filter((g) => !g.pass && g.name !== 'trials' && g.name !== 'plateau')
    .map((g) => g.name);
  const expectancy = pnls.length ? meanOf(pnls) : null;
  let bonferroniLow: number | null = null;
  if (pnls.length >= 2) {
    bonferroniLow = bootstrapCi(pnls, meanOf, {
      iterations: DIRECTION_EXIT_BOOTSTRAP.resamples,
      meanBlockLen: horizon,
      seed: DIRECTION_EXIT_BOOTSTRAP.seed,
      alpha: 1 - DIRECTION_EXIT_VERDICT_LEVEL,
    }).low;
  }
  if (!(bonferroniLow !== null && bonferroniLow > 0)) failed.push('bonferroni');
  const parts = DIRECTION_EXIT_CONFIRM_PARTS.map((p) => {
    const lo = Date.parse(p.start);
    const hi = Date.parse(p.end);
    const v = trades.filter((t) => t.exitTime >= lo && t.exitTime <= hi).map((t) => t.pnlPercent);
    const name = p.start.slice(0, 4);
    const e = v.length ? meanOf(v) : null;
    if (!(e !== null && e > 0)) failed.push(`part:${name}`);
    return { part: name, n: v.length, expectancy: e };
  });
  let dsr: number | null = null;
  if (pnls.length >= 2) {
    const { skewness, kurtosis } = moments(pnls);
    const p = deflatedSharpe({
      observedSharpe: perPeriodSharpe(pnls),
      numTrials: input.numTrials,
      varianceOfTrialSharpes: input.varianceOfTrialSharpes,
      nObservations: pnls.length,
      skewness,
      kurtosis,
    }).probability;
    dsr = Number.isNaN(p) ? null : p;
  }
  if (!(dsr !== null && dsr >= 0.95)) failed.push('dsr');
  return {
    config: input.config,
    pass: failed.length === 0,
    failed,
    expectancy,
    bonferroniLow,
    parts,
    dsr,
    reported: reportedStats(trades, horizon, input.exit, input.candles),
  };
}

function reportedStats(
  trades: DxTrade[],
  horizon: number,
  exit: number | undefined,
  candles: Record<string, CandleRow[]> | undefined
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const wins = trades.filter((t) => t.pnlPercent > 0).map((t) => t.pnlPercent);
  const losses = trades.filter((t) => t.pnlPercent < 0).map((t) => t.pnlPercent);
  out.winRate = trades.length ? wins.length / trades.length : null;
  out.avgWin = wins.length ? meanOf(wins) : null;
  out.avgLoss = losses.length ? meanOf(losses) : null;
  for (const t of trades) {
    const key = `exitReason:${t.exitReason}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  out.protectiveStops =
    exit === 1 || exit === 2 || exit === 4 ? trades.filter((t) => t.exitReason === 'stop_loss').length : null;
  out.mfeCapture = candles ? mfeCapture(trades, candles) : null;
  // Realised up is taken after costs (pnlPercent), an approximation of the gross direction.
  const called = trades.map((t) => (t.side === 'long' ? 1 : 0));
  const realised = trades.map((t) => ((t.side === 'long' && t.pnlPercent > 0) || (t.side === 'short' && t.pnlPercent < 0) ? 1 : 0));
  out.ptT = neweyWestT(called, realised, horizon);
  out.agStat = anatolyevGerko(trades.map((t) => t.pnlPercent));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

const REPORT_NAME = /^(dx-d[012])-(1h|4h)-c(\d)-e(\d)-k([\d.]+)\.json$/;

interface NamedReport {
  file: string;
  family: string;
  interval: '1h' | '4h';
  cond: number;
  exit: number;
  k: number;
  report: unknown;
  trades: DxTrade[];
}

function loadReports(dir: string): NamedReport[] {
  return readdirSync(dir)
    .sort()
    .map((file) => {
      const m = REPORT_NAME.exec(file);
      if (!m) return null;
      const report = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
      return {
        file,
        family: m[1],
        interval: m[2] as '1h' | '4h',
        cond: Number(m[3]),
        exit: Number(m[4]),
        k: Number(m[5]),
        report,
        trades: tradesOf(report),
      };
    })
    .filter((r): r is NamedReport => r !== null);
}

function runOf(r: NamedReport, key: string, coverage?: number) {
  const pnls = r.trades.map((t) => t.pnlPercent);
  return { key, expectancy: pnls.length ? meanOf(pnls) : null, trades: pnls.length, coverage };
}

function sampleVariance(x: number[]): number {
  if (x.length < 2) return 0;
  const m = meanOf(x);
  return x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1);
}

export function selectFor(reports: NamedReport[], interval: '1h' | '4h'): DirectionExitSelection {
  const at = reports.filter((r) => r.interval === interval);
  const d0e1 = at.find((r) => r.family === 'dx-d0' && r.exit === 1);
  if (!d0e1) throw new Error(`select: no dx-d0 E1 report at ${interval}`);
  const d2e1 = at.filter((r) => r.family === 'dx-d2' && r.exit === 1).sort((a, b) => a.cond - b.cond);
  const condRuns = d2e1.map((r) => runOf(r, String(r.cond), r.trades.length / Math.max(1, d0e1.trades.length)));
  const d2Condition = Number(pickBest(condRuns, { minCoverage: DIRECTION_EXIT_MIN_D2_COVERAGE })) as 1 | 2 | 3 | 4;
  const bestK = (family: string, exit: number): number => {
    const runs = at
      .filter((r) => r.family === family && r.exit === exit && (family !== 'dx-d2' || r.cond === d2Condition))
      .sort((a, b) => a.k - b.k);
    return Number(pickBest(runs.map((r) => runOf(r, String(r.k))), {}));
  };
  const kFor = (exit: number) => ({ d0: bestK('dx-d0', exit), d1: bestK('dx-d1', exit), d2: bestK('dx-d2', exit) });
  return { d2Condition, e2K: kFor(2), e3K: kFor(3) };
}

function flag(argv: string[], name: string): string {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || !argv[i + 1]) throw new Error(`missing --${name}`);
  return argv[i + 1];
}

function runSelect(argv: string[]): void {
  const reports = loadReports(flag(argv, 'develop-dir'));
  if (reports.length === 0) throw new Error('select: no develop reports found');
  const variance = sampleVariance(reports.map((r) => perPeriodSharpe(r.trades.map((t) => t.pnlPercent))));
  for (const cell of DIRECTION_EXIT_CELLS) {
    console.log(JSON.stringify({ interval: cell.interval, selection: selectFor(reports, cell.interval) }));
  }
  console.log(JSON.stringify({ varianceOfTrialSharpes: variance, reports: reports.length }));
}

function runVerdict(argv: string[]): void {
  const dir = flag(argv, 'confirm-dir');
  const variance = Number(flag(argv, 'variance'));
  const datasetDir = flag(argv, 'dataset-dir');
  if (!Number.isFinite(variance)) throw new Error('--variance must be a number');
  const reports = loadReports(dir);
  const cache = new Map<string, CandleRow[]>();
  const verdicts: Verdict[] = [];
  for (const r of reports) {
    const cell = DIRECTION_EXIT_CELLS.find((c) => c.interval === r.interval);
    if (!cell) continue;
    const candles: Record<string, CandleRow[]> = {};
    for (const symbol of new Set(r.trades.map((t) => t.symbol))) {
      const ck = `${symbol}:${r.interval}`;
      if (!cache.has(ck)) cache.set(ck, loadCandles(datasetDir, symbol, r.interval, { allowLockbox: true }).rows);
      candles[symbol] = cache.get(ck) as CandleRow[];
    }
    const v = judgeConfiguration({
      config: r.file.replace(/\.json$/, ''),
      report: r.report,
      varianceOfTrialSharpes: variance,
      numTrials: DIRECTION_EXIT_LEDGER_AFTER,
      horizonBars: cell.horizonBars,
      exit: r.exit,
      candles,
    });
    verdicts.push(v);
    console.log(
      `${v.pass ? 'PASS' : 'FAIL'} ${v.config} exp=${v.expectancy?.toFixed(4) ?? 'null'} bonfLow=${v.bonferroniLow?.toFixed(4) ?? 'null'} dsr=${v.dsr?.toFixed(3) ?? 'null'} failed=[${v.failed.join(',')}]`
    );
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify(
      {
        note: 'ptT: realised up is taken after costs (pnlPercent), an approximation of the gross direction. Reported statistics never gate.',
        numTrials: DIRECTION_EXIT_LEDGER_AFTER,
        varianceOfTrialSharpes: variance,
        verdicts,
      },
      null,
      2
    )
  );
}

function main(): void {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'select') runSelect(rest);
  else if (mode === 'verdict') runVerdict(rest);
  else throw new Error('usage: direction-exit-judge.ts select|verdict ...');
}

if (require.main === module) main();
