/**
 * Jobs, selection and verdict judge of the direction-exit study (spec: header of scripts/research/direction-exit.ts).
 *
 *   jobs <develop-a|develop-b|confirm> [--cond-file cond.json] [--select-file select.json]
 *       prints one job per line, `<name> <family> <interval> <fix-params>`, generated from the committed constants
 *       (develop-b from DIRECTION_EXIT_D2_CONDITION, confirm from DIRECTION_EXIT_SELECTION), never typed by hand;
 *       a given file must equal the committed values.
 *   check-fit --diagnosis <diagnosis.json> --expect-manifest-hash <h>
 *       the committed DIRECTION_EXIT_FIT must equal the diagnosis's lag-1 fit.
 *   cond    --develop-dir <dir> --expect-manifest-hash <h>     D2's condition from the 40 develop-a reports
 *   select  --develop-dir <dir> --expect-manifest-hash <h>     the develop picks from the 54 develop reports
 *   verdict --confirm-dir <dir> --select-file <select.json> --dataset-dir <dir> --expect-manifest-hash <h>
 *
 * Every mode that reads reports loads exactly the job names (no stray dx-*.json), validates each against the
 * harness's report schema, and asserts its provenance: the filename's family, interval and parameters, the
 * window (DEVELOP, benchmark off; or CONFIRM, benchmark on), six windows, the ten symbols, the dataset hash, and
 * one recorded commit per run stage. The verdict is never tuned on the confirmation window.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { bootstrapCi, meanOf } from '@/lib/stats/block-bootstrap';
import { deflatedSharpe, perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import type { CandleRow } from './dataset-format';
import {
  DIRECTION_EXIT_BOOTSTRAP,
  DIRECTION_EXIT_CELLS,
  DIRECTION_EXIT_CONFIRM,
  DIRECTION_EXIT_CONFIRM_PARTS,
  DIRECTION_EXIT_D2_CONDITION,
  DIRECTION_EXIT_DEVELOP,
  DIRECTION_EXIT_EXPORT,
  DIRECTION_EXIT_FIT,
  DIRECTION_EXIT_K_GRID,
  DIRECTION_EXIT_LEDGER_AFTER,
  DIRECTION_EXIT_MIN_D2_COVERAGE,
  DIRECTION_EXIT_SELECTION,
  DIRECTION_EXIT_SYMBOLS,
  DIRECTION_EXIT_VERDICT_LEVEL,
  DIRECTION_EXIT_WINDOWS,
  type DirectionExitFit,
  type DirectionExitSelection,
} from './direction-exit';
import { assertDatasetHash } from './direction-exit-rows';
import { loadCandles } from './load-dataset';
import { validateStrategyReport, type StrategyReport } from './report-schema';
import { MIN_IS_TRADES } from './strategy-harness';

type Interval = '1h' | '4h';
type Family = 'dx-d0' | 'dx-d1' | 'dx-d2';
type Condition = 1 | 2 | 3 | 4;
const INTERVALS: readonly Interval[] = DIRECTION_EXIT_CELLS.map((c) => c.interval);

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

/** The harness gates VERDICT rule 1 keeps; trials and plateau are inert for one cell and replaced by the dsr. */
export const DIRECTION_EXIT_HARNESS_GATES = ['sample', 'expectancy', 'windows', 'symbols', 'timing', 'stress'] as const;

/**
 * The one report-name pattern (without `.json`), shared verbatim with the runbook's NAME_RE (a test pins it).
 * D0 and D1 carry c0; E1 and E4 carry k1.
 */
export const REPORT_NAME_PATTERN = '^dx-d([012])-(1h|4h)-c([0-4])-e([1-4])-k(1|1\\.5|2)$';
const REPORT_NAME = new RegExp(REPORT_NAME_PATTERN);

// ---------------------------------------------------------------------------------------------------------------
// Jobs

export interface DxJob {
  name: string;
  family: Family;
  interval: Interval;
  /** 0 for D0 and D1. */
  cond: number;
  exit: number;
  k: number;
}

function job(family: Family, interval: Interval, cond: number, exit: number, k: number): DxJob {
  return { name: `${family}-${interval}-c${cond}-e${exit}-k${k}`, family, interval, cond, exit, k };
}

/** The --fix-params the job's harness run takes, in the order the line prints them. */
export function fixParamsOf(j: Pick<DxJob, 'family' | 'cond' | 'exit' | 'k'>): Record<string, number> {
  return j.family === 'dx-d2' ? { cond: j.cond, exit: j.exit, k: j.k } : { exit: j.exit, k: j.k };
}

export function jobLine(j: DxJob): string {
  const params = Object.entries(fixParamsOf(j)).map(([k, v]) => `${k}=${v}`).join(',');
  return `${j.name} ${j.family} ${j.interval} ${params}`;
}

/** D0 and D1 at E1, E2 x k, E3 x k and E4, and D2's four conditions at E1: 20 per interval, 40 in all. */
export function developAJobs(): DxJob[] {
  return INTERVALS.flatMap((iv) => [
    ...(['dx-d0', 'dx-d1'] as const).flatMap((f) => [
      job(f, iv, 0, 1, 1),
      ...[2, 3].flatMap((e) => DIRECTION_EXIT_K_GRID.map((k) => job(f, iv, 0, e, k))),
      job(f, iv, 0, 4, 1),
    ]),
    ...[1, 2, 3, 4].map((c) => job('dx-d2', iv, c, 1, 1)),
  ]);
}

/** D2 under its interval's condition at E2 x k, E3 x k and E4: 7 per interval, 14 in all. */
export function developBJobs(conds: Record<Interval, Condition>): DxJob[] {
  return INTERVALS.flatMap((iv) => [
    ...[2, 3].flatMap((e) => DIRECTION_EXIT_K_GRID.map((k) => job('dx-d2', iv, conds[iv], e, k))),
    job('dx-d2', iv, conds[iv], 4, 1),
  ]);
}

/** Every develop-b name any condition could give, for cond mode run after develop-b. */
function anyDevelopBName(): Set<string> {
  return new Set(
    ([1, 2, 3, 4] as const).flatMap((c) => developBJobs({ '1h': c, '4h': c }).map((j) => j.name))
  );
}

/** D0, D1 and D2 (under its condition) at E1, E2 at its k, E3 at its k and E4: 12 per interval, 24 in all. */
export function confirmJobs(selection: Record<Interval, DirectionExitSelection>): DxJob[] {
  return INTERVALS.flatMap((iv) => {
    const s = selection[iv];
    return (['d0', 'd1', 'd2'] as const).flatMap((v) => {
      const family = `dx-${v}` as Family;
      const c = v === 'd2' ? s.d2Condition : 0;
      return [job(family, iv, c, 1, 1), job(family, iv, c, 2, s.e2K[v]), job(family, iv, c, 3, s.e3K[v]), job(family, iv, c, 4, 1)];
    });
  });
}

export interface CommittedSources {
  conds: Record<Interval, Condition | null>;
  selection: Record<Interval, DirectionExitSelection | null>;
}

const COMMITTED: CommittedSources = { conds: DIRECTION_EXIT_D2_CONDITION, selection: DIRECTION_EXIT_SELECTION };

function committedConditions(conds: CommittedSources['conds']): Record<Interval, Condition> {
  for (const iv of INTERVALS) {
    if (conds[iv] === null) throw new Error(`DIRECTION_EXIT_D2_CONDITION['${iv}'] is not committed`);
  }
  return conds as Record<Interval, Condition>;
}

function committedSelection(sources: CommittedSources): Record<Interval, DirectionExitSelection> {
  const conds = committedConditions(sources.conds);
  for (const iv of INTERVALS) {
    const s = sources.selection[iv];
    if (s === null) throw new Error(`DIRECTION_EXIT_SELECTION['${iv}'] is not committed`);
    if (s.d2Condition !== conds[iv]) {
      throw new Error(`${iv}: DIRECTION_EXIT_SELECTION d2Condition ${s.d2Condition} differs from DIRECTION_EXIT_D2_CONDITION ${conds[iv]}`);
    }
  }
  return sources.selection as Record<Interval, DirectionExitSelection>;
}

const ConditionFileSchema = z.object({ '1h': z.number(), '4h': z.number() });
const SelectionSchema = z.object({
  d2Condition: z.number(),
  e2K: z.object({ d0: z.number(), d1: z.number(), d2: z.number() }),
  e3K: z.object({ d0: z.number(), d1: z.number(), d2: z.number() }),
});
const SelectFileSchema = z.object({
  selection: z.object({ '1h': SelectionSchema, '4h': SelectionSchema }),
  varianceOfTrialSharpes: z.number().optional(),
});

function sameSelection(a: DirectionExitSelection, b: z.infer<typeof SelectionSchema>): boolean {
  const v = ['d0', 'd1', 'd2'] as const;
  return a.d2Condition === b.d2Condition && v.every((x) => a.e2K[x] === b.e2K[x] && a.e3K[x] === b.e3K[x]);
}

/** Throws unless the select.json selection equals the committed one at both intervals. */
export function assertSelectFile(committed: Record<Interval, DirectionExitSelection>, file: unknown): void {
  const parsed = SelectFileSchema.parse(file);
  for (const iv of INTERVALS) {
    if (!sameSelection(committed[iv], parsed.selection[iv])) {
      throw new Error(
        `${iv}: committed selection ${JSON.stringify(committed[iv])} differs from select.json ${JSON.stringify(parsed.selection[iv])}`
      );
    }
  }
}

/** The jobs of a run stage, from the committed constants only; a given judge output file must agree with them. */
export function jobsFor(
  stage: 'develop-a' | 'develop-b' | 'confirm',
  files: { condFile?: unknown; selectFile?: unknown },
  sources: CommittedSources = COMMITTED
): DxJob[] {
  if (stage === 'develop-a') return developAJobs();
  if (stage === 'develop-b') {
    const conds = committedConditions(sources.conds);
    if (files.condFile !== undefined) {
      const file = ConditionFileSchema.parse(files.condFile);
      for (const iv of INTERVALS) {
        if (file[iv] !== conds[iv]) throw new Error(`${iv}: cond.json has condition ${file[iv]}, committed ${conds[iv]}`);
      }
    }
    return developBJobs(conds);
  }
  const selection = committedSelection(sources);
  if (files.selectFile !== undefined) assertSelectFile(selection, files.selectFile);
  return confirmJobs(selection);
}

// ---------------------------------------------------------------------------------------------------------------
// Fit check

const DiagnosisFileSchema = z.object({
  datasetHash: z.string(),
  reports: z.array(
    z.object({
      interval: z.string(),
      lag: z.number(),
      fit: z.object({
        signs: z.record(z.string(), z.number()),
        threshold: z.number(),
        volTopThreshold: z.record(z.string(), z.number().nullable()),
      }),
    })
  ),
});

/** Every difference between the committed fit and the diagnosis's lag-1 fit (signs exact, T to 1e-9, vol to 1e-12). */
export function checkFit(committed: Record<Interval, DirectionExitFit | null>, diagnosis: unknown, expectHash: string): string[] {
  const d = DiagnosisFileSchema.parse(diagnosis);
  const problems: string[] = [];
  if (d.datasetHash !== expectHash) problems.push(`diagnosis datasetHash ${d.datasetHash}, expected ${expectHash}`);
  for (const iv of INTERVALS) {
    const fit = committed[iv];
    const lag1 = d.reports.filter((r) => r.interval === iv && r.lag === 1);
    if (fit === null) {
      problems.push(`${iv}: DIRECTION_EXIT_FIT is not committed`);
      continue;
    }
    if (lag1.length !== 1) {
      problems.push(`${iv}: the diagnosis has ${lag1.length} lag-1 reports, expected 1`);
      continue;
    }
    const want = lag1[0].fit;
    const signKeys = new Set([...Object.keys(fit.signs), ...Object.keys(want.signs)]);
    for (const c of signKeys) {
      const a = (fit.signs as Record<string, number>)[c];
      if (a !== want.signs[c]) problems.push(`${iv} sign ${c}: committed ${a}, diagnosis ${want.signs[c]}`);
    }
    if (!(Math.abs(fit.threshold - want.threshold) <= 1e-9)) {
      problems.push(`${iv} threshold: committed ${fit.threshold}, diagnosis ${want.threshold}`);
    }
    const symbols = new Set([...Object.keys(fit.volTopThreshold), ...Object.keys(want.volTopThreshold)]);
    for (const s of symbols) {
      const a = fit.volTopThreshold[s];
      const b = want.volTopThreshold[s];
      const same = a === null || b === null || a === undefined || b === undefined ? a === b : Math.abs(a - b) <= 1e-12;
      if (!same) problems.push(`${iv} volTopThreshold ${s}: committed ${a}, diagnosis ${b}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Reports

export interface NamedReport {
  file: string;
  name: string;
  family: string;
  interval: Interval;
  cond: number;
  exit: number;
  k: number;
  report: StrategyReport;
  trades: DxTrade[];
}

/** Every window's trades, required, in exit order; their count must equal the report's pooled.n. */
export function tradesOf(report: StrategyReport): DxTrade[] {
  const trades: DxTrade[] = [];
  for (const s of report.perSymbol) {
    s.windows.forEach((w, i) => {
      if (!w.trades) throw new Error(`${report.family} ${report.interval} ${s.symbol}: window ${i} has no trades (not a fixed-eval report)`);
      for (const t of w.trades) {
        trades.push({ symbol: s.symbol, entryTime: t.entryTime, exitTime: t.exitTime, side: t.side, pnlPercent: t.pnlPercent, exitReason: t.exitReason });
      }
    });
  }
  if (trades.length !== report.pooled.n) {
    throw new Error(`${report.family} ${report.interval}: ${trades.length} window trades but pooled.n ${report.pooled.n}`);
  }
  return trades.sort((a, b) => a.exitTime - b.exitTime);
}

export function namedReport(name: string, report: StrategyReport): NamedReport {
  const m = REPORT_NAME.exec(name);
  if (!m) throw new Error(`report name ${name} does not match ${REPORT_NAME_PATTERN}`);
  return {
    file: `${name}.json`,
    name,
    family: `dx-d${m[1]}`,
    interval: m[2] as Interval,
    cond: Number(m[3]),
    exit: Number(m[4]),
    k: Number(m[5]),
    report,
    trades: tradesOf(report),
  };
}

/** Missing expected files and stray dx-*.json files (any other report name, valid or not) in a directory listing. */
export function directoryProblems(files: string[], names: readonly string[], allowStray: (name: string) => boolean = () => false): string[] {
  const expected = new Set(names);
  const present = new Set(files);
  const problems = names.filter((n) => !present.has(`${n}.json`)).map((n) => `missing ${n}.json`);
  for (const f of files) {
    if (!f.startsWith('dx-') || !f.endsWith('.json')) continue;
    const base = f.slice(0, -'.json'.length);
    if (!expected.has(base) && !allowStray(base)) problems.push(`stray ${f}`);
  }
  return problems;
}

/** Loads exactly `names` from `dir`, each validated against the harness's report schema. */
export function loadReports(dir: string, names: readonly string[], allowStray?: (name: string) => boolean): NamedReport[] {
  const problems = directoryProblems(readdirSync(dir).sort(), names, allowStray);
  if (problems.length > 0) throw new Error(`report files in ${dir}: ${problems.join(', ')}`);
  return names.map((name) => {
    const validated = validateStrategyReport(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as unknown);
    if (!validated.ok) throw new Error(`${name}.json fails the strategy report schema: ${validated.issues.slice(0, 5).join('; ')}`);
    return namedReport(name, validated.data);
  });
}

/** Everything that ties a report to its job and its stage; an empty list means it is the run its name says. */
export function provenanceProblems(r: NamedReport, stage: 'develop' | 'confirm', expectHash: string): string[] {
  const p: string[] = [];
  const rep = r.report;
  const win = stage === 'develop' ? DIRECTION_EXIT_DEVELOP : DIRECTION_EXIT_CONFIRM;
  if (rep.family !== r.family) p.push(`family ${rep.family}, name says ${r.family}`);
  if (rep.interval !== r.interval) p.push(`interval ${rep.interval}, name says ${r.interval}`);
  const want = fixParamsOf({ family: r.family as Family, cond: r.cond, exit: r.exit, k: r.k });
  const got = rep.fixedParams;
  const sameParams =
    got !== undefined &&
    Object.keys(got).length === Object.keys(want).length &&
    Object.entries(want).every(([k, v]) => got[k] === v);
  if (!sameParams) p.push(`fixedParams ${JSON.stringify(got)}, name says ${JSON.stringify(want)}`);
  if (rep.datasetManifestHash !== expectHash) p.push(`datasetManifestHash ${rep.datasetManifestHash}, expected ${expectHash}`);
  if ([...rep.symbols].sort().join(',') !== [...DIRECTION_EXIT_SYMBOLS].sort().join(',')) p.push(`symbols ${rep.symbols.join(',')}`);
  if (rep.windowConfig.count !== DIRECTION_EXIT_WINDOWS) p.push(`windows ${rep.windowConfig.count}, expected ${DIRECTION_EXIT_WINDOWS}`);
  if (rep.benchmark.enabled !== (stage === 'confirm')) p.push(`benchmark ${rep.benchmark.enabled ? 'on' : 'off'} on a ${stage} run`);
  if (rep.dateRange.startMs !== Date.parse(DIRECTION_EXIT_EXPORT.start)) p.push(`dateRange.startMs ${rep.dateRange.startMs}, expected ${DIRECTION_EXIT_EXPORT.start}`);
  if (rep.dateRange.endMs !== Date.parse(win.end)) p.push(`dateRange.endMs ${rep.dateRange.endMs}, expected ${win.end}`);
  const fe = rep.fixedEvaluation;
  if (!fe) {
    p.push('not a fixed-eval report');
  } else {
    if (fe.evalFrom !== Date.parse(win.start)) p.push(`fixedEvaluation.evalFrom ${fe.evalFrom}, expected ${win.start}`);
    if (fe.fundingSource !== 'settlements') p.push(`fundingSource ${fe.fundingSource}, expected settlements`);
    if (fe.price !== 'spot') p.push(`price ${fe.price}, expected spot`);
  }
  return p;
}

function assertProvenance(reports: NamedReport[], stage: 'develop' | 'confirm', expectHash: string): void {
  const problems = reports.flatMap((r) => provenanceProblems(r, stage, expectHash).map((x) => `${r.name}: ${x}`));
  if (problems.length > 0) throw new Error(`${problems.length} provenance problems: ${problems.slice(0, 10).join('; ')}`);
}

/** The one commit every report of a run stage recorded; throws on two commits or an unknown one. */
export function commitOf(reports: NamedReport[], label: string): string {
  const commits = [...new Set(reports.map((r) => r.report.gitCommit))];
  if (commits.length !== 1) throw new Error(`${label}: reports carry ${commits.length} commits (${commits.join(', ')})`);
  if (commits[0] === 'unknown' || commits[0] === '') throw new Error(`${label}: reports carry an unknown commit`);
  return commits[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Statistics

export function pickBest(
  runs: Array<{ key: string; expectancy: number | null; trades: number; coverage?: number }>,
  opts: { minTrades: number; minCoverage?: number }
): string {
  const ok = runs.filter(
    (r) =>
      r.expectancy !== null &&
      r.trades >= opts.minTrades &&
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

/**
 * The Anatolyev-Gerko (2005) excess-profitability statistic, Ruling R12: EP = (A - B) / sqrt(V) with
 * A = mean(f r), B = mean(f) mean(r), V = 4 / T^2 p (1 - p) sum (r - rbar)^2 and p = (1 + mean(f)) / 2, for calls
 * f (+1 long, -1 short) and the asset's returns r over each call. Null under 2 calls, with one call direction
 * only (V = 0) or mismatched inputs.
 */
export function anatolyevGerko(f: number[], r: number[]): number | null {
  const T = f.length;
  if (T < 2 || r.length !== T) return null;
  const fBar = meanOf(f);
  const rBar = meanOf(r);
  const A = meanOf(f.map((fi, i) => fi * r[i]));
  const B = fBar * rBar;
  const p = (1 + fBar) / 2;
  const V = (4 / T ** 2) * p * (1 - p) * r.reduce((s, ri) => s + (ri - rBar) ** 2, 0);
  if (!(V > 0)) return null;
  return (A - B) / Math.sqrt(V);
}

/** First index with rows[i].t >= t in rows sorted by t. */
function lowerBound(rows: CandleRow[], t: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Net MFE capture: the mean over trades of the trade's realised net return (pnlPercent, after fees, slippage and
 * funding) over its maximum favourable excursion. The MFE is measured in the trade's direction from the entry
 * bar's open (the next-open fill) over the bars it was held; a 'signal' exit fills at the exit bar's open
 * (exitFill 'next-open'), so that bar contributes its open only. Trades without candles or without a positive
 * MFE are skipped. Candle rows must be sorted by t.
 */
export function mfeCaptureNet(trades: DxTrade[], candles: Record<string, CandleRow[]>): number | null {
  const caps: number[] = [];
  for (const t of trades) {
    const rows = candles[t.symbol];
    if (!rows) continue;
    const i0 = lowerBound(rows, t.entryTime);
    if (i0 >= rows.length || rows[i0].t !== t.entryTime) continue;
    const dir = t.side === 'long' ? 1 : -1;
    const entry = rows[i0].o;
    const atNextOpen = t.exitReason === 'signal';
    let best = entry;
    for (let i = i0; i < rows.length && rows[i].t <= t.exitTime; i++) {
      const c = rows[i];
      const touched = atNextOpen && c.t === t.exitTime ? c.o : dir === 1 ? c.h : c.l;
      best = dir === 1 ? Math.max(best, touched) : Math.min(best, touched);
    }
    const mfe = (dir * (best - entry)) / entry;
    if (!(mfe > 0)) continue;
    caps.push(t.pnlPercent / 100 / mfe);
  }
  return caps.length ? meanOf(caps) : null;
}

export function judgeConfiguration(input: {
  config: string;
  report: StrategyReport;
  varianceOfTrialSharpes: number;
  numTrials: number;
  horizonBars?: number;
  /** Exit mode 1 to 4, for the protective-stop count. */
  exit?: number;
  candles?: Record<string, CandleRow[]>;
}): Verdict {
  const trades = tradesOf(input.report);
  const pnls = trades.map((t) => t.pnlPercent);
  const horizon = input.horizonBars ?? 24;
  const failed: string[] = [];
  for (const name of DIRECTION_EXIT_HARNESS_GATES) {
    const gate = input.report.gates.find((g) => g.name === name);
    if (!gate) failed.push(`gate-missing:${name}`);
    else if (!gate.pass) failed.push(name);
  }
  const expectancy = pnls.length ? meanOf(pnls) : null;
  let bonferroniLow: number | null = null;
  if (pnls.length >= 2) {
    // Stationary block bootstrap (geometric blocks) over the pooled trades in exit order, mean block = the
    // horizon counted in trades (note N10).
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

/** What the verdict's reported statistics mean; written into verdict.json. */
export const DIRECTION_EXIT_REPORTED_NOTE =
  'Reported statistics never gate. All are net and lagged: each trade enters at the next open and its outcome is ' +
  'its pnlPercent after fees, slippage and funding. balancedHitRate = mean of the long and short shares with ' +
  'pnlPercent > 0. ptT = Pesaran-Timmermann regression t of the realised up-indicator (long and pnl > 0, or short ' +
  'and pnl < 0) on the call up-indicator, Newey-West lag = the horizon counted in trades, not bars. agStat = ' +
  'Anatolyev-Gerko EP (Ruling R12) with f = +1 long / -1 short and r = f x pnlPercent, the net asset move implied ' +
  'by each trade. mfeCaptureNet = mean of pnlPercent over the trade MFE from the entry open (candles).';

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
  out.payoff = out.avgWin !== null && out.avgLoss !== null && out.avgLoss !== 0 ? out.avgWin / Math.abs(out.avgLoss) : null;
  const hit = (side: 'long' | 'short'): number | null => {
    const s = trades.filter((t) => t.side === side);
    return s.length ? s.filter((t) => t.pnlPercent > 0).length / s.length : null;
  };
  const longHit = hit('long');
  const shortHit = hit('short');
  out.balancedHitRate = longHit !== null && shortHit !== null ? (longHit + shortHit) / 2 : null;
  for (const t of trades) {
    const key = `exitReason:${t.exitReason}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  out.protectiveStops =
    exit === 1 || exit === 2 || exit === 4 ? trades.filter((t) => t.exitReason === 'stop_loss').length : null;
  out.mfeCaptureNet = candles ? mfeCaptureNet(trades, candles) : null;
  const f = trades.map((t) => (t.side === 'long' ? 1 : -1));
  const called = trades.map((t) => (t.side === 'long' ? 1 : 0));
  const realised = trades.map((t) => ((t.side === 'long' && t.pnlPercent > 0) || (t.side === 'short' && t.pnlPercent < 0) ? 1 : 0));
  out.ptT = neweyWestT(called, realised, horizon);
  out.agStat = anatolyevGerko(f, trades.map((t, i) => f[i] * t.pnlPercent));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Selection

function runOf(r: NamedReport, key: string, coverage?: number) {
  const pnls = r.trades.map((t) => t.pnlPercent);
  return { key, expectancy: pnls.length ? meanOf(pnls) : null, trades: pnls.length, coverage };
}

function sampleVariance(x: number[]): number {
  if (x.length < 2) return 0;
  const m = meanOf(x);
  return x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1);
}

/**
 * D2's condition at an interval: the highest develop expectancy among the dx-d2 E1 runs keeping at least 30% of
 * the dx-d0 E1 trades, a tie to the higher coverage. No trade floor (Ruling R11, note N11).
 */
export function condFor(reports: NamedReport[], interval: Interval): Condition {
  const at = reports.filter((r) => r.interval === interval);
  const d0e1 = at.find((r) => r.family === 'dx-d0' && r.exit === 1);
  if (!d0e1) throw new Error(`cond: no dx-d0 E1 report at ${interval}`);
  const d2e1 = at.filter((r) => r.family === 'dx-d2' && r.exit === 1).sort((a, b) => a.cond - b.cond);
  const condRuns = d2e1.map((r) => runOf(r, String(r.cond), r.trades.length / Math.max(1, d0e1.trades.length)));
  return Number(pickBest(condRuns, { minTrades: 0, minCoverage: DIRECTION_EXIT_MIN_D2_COVERAGE })) as Condition;
}

/** k for E2 and E3 per variant: the highest develop expectancy over the harness's MIN_IS_TRADES, earliest k on a tie. */
export function selectFor(reports: NamedReport[], interval: Interval): DirectionExitSelection {
  const at = reports.filter((r) => r.interval === interval);
  const d2Condition = condFor(reports, interval);
  const bestK = (family: string, exit: number): number => {
    const runs = at
      .filter((r) => r.family === family && r.exit === exit && (family !== 'dx-d2' || r.cond === d2Condition))
      .sort((a, b) => a.k - b.k);
    return Number(pickBest(runs.map((r) => runOf(r, String(r.k))), { minTrades: MIN_IS_TRADES }));
  };
  const kFor = (exit: number) => ({ d0: bestK('dx-d0', exit), d1: bestK('dx-d1', exit), d2: bestK('dx-d2', exit) });
  return { d2Condition, e2K: kFor(2), e3K: kFor(3) };
}

const isDevelopB = (r: NamedReport): boolean => r.family === 'dx-d2' && r.exit !== 1;

export interface SelectOutput {
  selection: Record<Interval, DirectionExitSelection>;
  varianceOfTrialSharpes: number;
  reports: number;
  datasetManifestHash: string;
  gitCommit: { developA: string; developB: string };
}

/** select.json from the 54 develop reports; the picked conditions must be the committed ones. */
export function buildSelect(reports: NamedReport[], conds: Record<Interval, Condition>): SelectOutput {
  if (reports.length !== developAJobs().length + developBJobs(conds).length) {
    throw new Error(`select: ${reports.length} develop reports, expected 54`);
  }
  const gitCommit = {
    developA: commitOf(reports.filter((r) => !isDevelopB(r)), 'develop-a'),
    developB: commitOf(reports.filter(isDevelopB), 'develop-b'),
  };
  const hashes = [...new Set(reports.map((r) => r.report.datasetManifestHash))];
  if (hashes.length !== 1) throw new Error(`select: reports carry ${hashes.length} dataset hashes`);
  const selection = Object.fromEntries(INTERVALS.map((iv) => [iv, selectFor(reports, iv)])) as Record<Interval, DirectionExitSelection>;
  for (const iv of INTERVALS) {
    if (selection[iv].d2Condition !== conds[iv]) {
      throw new Error(`${iv}: the develop-a reports pick condition ${selection[iv].d2Condition}, committed ${conds[iv]}`);
    }
  }
  return {
    selection,
    varianceOfTrialSharpes: sampleVariance(reports.map((r) => perPeriodSharpe(r.trades.map((t) => t.pnlPercent)))),
    reports: reports.length,
    datasetManifestHash: hashes[0],
    gitCommit,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

function flags(argv: string[], required: string[], optional: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const v = argv[++i];
    if (!flag.startsWith('--') || ![...required, ...optional].includes(flag.slice(2))) throw new Error(`Unknown argument "${flag}"`);
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    out[flag.slice(2)] = v;
  }
  for (const k of required) if (!out[k]) throw new Error(`--${k} is required`);
  return out;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;

function runJobs(argv: string[]): void {
  const [stage, ...rest] = argv;
  if (stage !== 'develop-a' && stage !== 'develop-b' && stage !== 'confirm') {
    throw new Error('usage: jobs <develop-a|develop-b|confirm> [--cond-file f] [--select-file f]');
  }
  const a = flags(rest, [], stage === 'develop-b' ? ['cond-file'] : stage === 'confirm' ? ['select-file'] : []);
  if (stage === 'develop-a') {
    // D1 and C2 read the committed fit; develop-a must never run without it.
    for (const iv of INTERVALS) if (DIRECTION_EXIT_FIT[iv] === null) throw new Error(`DIRECTION_EXIT_FIT['${iv}'] is not committed`);
  }
  const jobs = jobsFor(stage, {
    condFile: a['cond-file'] !== undefined ? readJson(a['cond-file']) : undefined,
    selectFile: a['select-file'] !== undefined ? readJson(a['select-file']) : undefined,
  });
  for (const j of jobs) console.log(jobLine(j));
}

function runCheckFit(argv: string[]): void {
  const a = flags(argv, ['diagnosis', 'expect-manifest-hash']);
  const problems = checkFit(DIRECTION_EXIT_FIT, readJson(a.diagnosis), a['expect-manifest-hash']);
  if (problems.length > 0) throw new Error(`check-fit: ${problems.join('; ')}`);
  console.log(`check-fit ok: DIRECTION_EXIT_FIT equals the lag-1 fit of ${a.diagnosis} at ${INTERVALS.join(', ')}`);
}

function runCond(argv: string[]): void {
  const a = flags(argv, ['develop-dir', 'expect-manifest-hash']);
  const hash = a['expect-manifest-hash'];
  const names = developAJobs().map((j) => j.name);
  const stray = anyDevelopBName();
  const reports = loadReports(a['develop-dir'], names, (n) => stray.has(n));
  assertProvenance(reports, 'develop', hash);
  const gitCommit = commitOf(reports, 'develop-a');
  console.error(`[dx-judge] cond: develop-a gitCommit ${gitCommit}`);
  console.log(JSON.stringify({ '1h': condFor(reports, '1h'), '4h': condFor(reports, '4h'), gitCommit, datasetManifestHash: hash }));
}

function runSelect(argv: string[]): void {
  const a = flags(argv, ['develop-dir', 'expect-manifest-hash']);
  const conds = committedConditions(DIRECTION_EXIT_D2_CONDITION);
  const names = [...developAJobs(), ...developBJobs(conds)].map((j) => j.name);
  const reports = loadReports(a['develop-dir'], names);
  assertProvenance(reports, 'develop', a['expect-manifest-hash']);
  const out = buildSelect(reports, conds);
  console.error(`[dx-judge] select: develop-a gitCommit ${out.gitCommit.developA}, develop-b gitCommit ${out.gitCommit.developB}`);
  console.log(JSON.stringify(out));
}

async function runVerdict(argv: string[]): Promise<void> {
  const a = flags(argv, ['confirm-dir', 'select-file', 'dataset-dir', 'expect-manifest-hash']);
  const hash = a['expect-manifest-hash'];
  const selection = committedSelection(COMMITTED);
  const selectFile = readJson(a['select-file']);
  assertSelectFile(selection, selectFile);
  const variance = SelectFileSchema.parse(selectFile).varianceOfTrialSharpes;
  if (variance === undefined || !Number.isFinite(variance) || variance < 0) {
    throw new Error(`${a['select-file']}: varianceOfTrialSharpes is missing or not a finite non-negative number`);
  }
  await assertDatasetHash(a['dataset-dir'], hash);
  const dir = a['confirm-dir'];
  const reports = loadReports(dir, confirmJobs(selection).map((j) => j.name));
  assertProvenance(reports, 'confirm', hash);
  const gitCommit = commitOf(reports, 'confirm');
  const cache = new Map<string, CandleRow[]>();
  const verdicts: Verdict[] = [];
  for (const r of reports) {
    const cell = DIRECTION_EXIT_CELLS.find((c) => c.interval === r.interval)!;
    const candles: Record<string, CandleRow[]> = {};
    for (const symbol of new Set(r.trades.map((t) => t.symbol))) {
      const ck = `${symbol}:${r.interval}`;
      if (!cache.has(ck)) cache.set(ck, loadCandles(a['dataset-dir'], symbol, r.interval, { allowLockbox: true }).rows);
      candles[symbol] = cache.get(ck) as CandleRow[];
    }
    const v = judgeConfiguration({
      config: r.name,
      report: r.report,
      varianceOfTrialSharpes: variance,
      numTrials: DIRECTION_EXIT_LEDGER_AFTER,
      horizonBars: cell.horizonBars,
      exit: r.exit,
      candles,
    });
    verdicts.push(v);
    console.log(
      `${v.pass ? 'PASS' : 'FAIL'} ${v.config} exp=${v.expectancy?.toFixed(4) ?? 'null'} bonfLow=${v.bonferroniLow?.toFixed(4) ?? 'null'} ` +
        `dsr=${v.dsr?.toFixed(3) ?? 'null'} failed=[${v.failed.join(',')}]`
    );
  }
  console.log(`confirm gitCommit ${gitCommit}`);
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify(
      {
        note: DIRECTION_EXIT_REPORTED_NOTE,
        datasetManifestHash: hash,
        gitCommit,
        numTrials: DIRECTION_EXIT_LEDGER_AFTER,
        varianceOfTrialSharpes: variance,
        verdicts,
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  try {
    const [mode, ...rest] = process.argv.slice(2);
    if (mode === 'jobs') runJobs(rest);
    else if (mode === 'check-fit') runCheckFit(rest);
    else if (mode === 'cond') runCond(rest);
    else if (mode === 'select') runSelect(rest);
    else if (mode === 'verdict') await runVerdict(rest);
    else throw new Error('usage: direction-exit-judge.ts jobs|check-fit|cond|select|verdict ...');
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

if (require.main === module) void main();
