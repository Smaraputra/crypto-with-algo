import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { defaultCostPercent } from '@/lib/backtest/cost-model';
import { pointMeasures, directionOf } from '@/lib/signals/track-record/measures';
import type { PointMeasures } from '@/lib/signals/track-record/types';
import { spearman } from './ic-stats';
import { seededRandom } from './carry-sim';
import { percentileType7 } from './live-record-stats';
import { CATEGORIES, type Category, type DxRow } from './direction-exit-rows';
import {
  DIRECTION_EXIT_ASIA_HOURS_UTC, DIRECTION_EXIT_BOOTSTRAP, DIRECTION_EXIT_CUTOFFS, DIRECTION_EXIT_K_GRID,
  DIRECTION_EXIT_RANDOM_DRAWS, type DirectionExitFit,
} from './direction-exit';

export interface CategoryDiag { category: Category; agreeShare: number | null; bh: number | null; n: number }
export interface ConditionDiag { id: 'C1' | 'C2' | 'C3' | 'C4'; holds: PointMeasures; fails: PointMeasures; coverage: number }
export interface PathDiag { k: number; callTouch: number; callFinish: number; randomTouch: number; randomFinish: number }
export interface DiagnosisReport {
  interval: string; calls: number; lag: 0 | 1;
  overall: PointMeasures; categories: CategoryDiag[]; conditions: ConditionDiag[]; paths: PathDiag[];
  fit: DirectionExitFit;
}

const outcome = (r: DxRow, lag: 0 | 1): number | null => (lag === 0 ? r.fwd : r.fwd1);
const quantile = (values: number[], p: number): number => percentileType7([...values].sort((a, b) => a - b), p);
function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

export function d1Score(cats: Record<Category, number | null>, signs: DirectionExitFit['signs']): number | null {
  let sum = 0;
  let n = 0;
  for (const c of CATEGORIES) {
    const v = cats[c];
    if (v === null) continue;
    sum += signs[c] * v;
    n++;
  }
  return n > 0 ? sum / n : null;
}

export function volTopThresholds(rows: DxRow[]): Record<string, number | null> {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    if (!by.has(r.symbol)) by.set(r.symbol, []);
    if (r.vol20 !== null) by.get(r.symbol)!.push(r.vol20);
  }
  return Object.fromEntries([...by].map(([s, v]) => [s, v.length > 0 ? quantile(v, 2 / 3) : null]));
}

export function conditionHolds(id: 'C1' | 'C2' | 'C3' | 'C4', row: DxRow, dir: 1 | -1, volTop: Record<string, number | null>): boolean {
  if (id === 'C1') return row.cats.htf !== null && Math.sign(row.cats.htf) === dir;
  if (id === 'C2') {
    const t = volTop[row.symbol] ?? null;
    return row.vol20 !== null && t !== null && row.vol20 <= t;
  }
  if (id === 'C3') return Math.abs(row.score) > DIRECTION_EXIT_CUTOFFS.strong;
  return row.hourUtc >= DIRECTION_EXIT_ASIA_HOURS_UTC.to;
}

function measured(rows: DxRow[], lag: 0 | 1, tierOf: (r: DxRow) => string) {
  const out: Array<{ tier: string; forwardReturnPercent: number }> = [];
  for (const r of rows) {
    const f = outcome(r, lag);
    if (f !== null && Number.isFinite(f)) out.push({ tier: tierOf(r), forwardReturnPercent: f });
  }
  return out;
}

/** Same symbol, same vol20 tercile of that symbol's whole develop span; a null vol20 is its own pool. */
function randomPools(rows: DxRow[]): (r: DxRow) => DxRow[] {
  const bySymbol = new Map<string, number[]>();
  for (const r of rows) if (r.vol20 !== null) push(bySymbol, r.symbol, r.vol20);
  const cuts = new Map<string, [number, number]>();
  for (const [sym, v] of bySymbol) cuts.set(sym, [quantile(v, 1 / 3), quantile(v, 2 / 3)]);
  const keyOf = (r: DxRow): string => {
    const c = cuts.get(r.symbol);
    if (r.vol20 === null || !c) return `${r.symbol}|na`;
    return `${r.symbol}|${r.vol20 <= c[0] ? 0 : r.vol20 <= c[1] ? 1 : 2}`;
  };
  const pool = new Map<string, DxRow[]>();
  for (const r of rows) push(pool, keyOf(r), r);
  return (r) => pool.get(keyOf(r)) ?? [];
}

function pathStats(rows: DxRow[], calls: Array<{ r: DxRow; d: 1 | -1 }>, lag: 0 | 1): PathDiag[] {
  const poolOf = randomPools(rows);
  const random = seededRandom(DIRECTION_EXIT_BOOTSTRAP.seed);
  const mfe = (r: DxRow, d: 1 | -1): number =>
    lag === 0 ? (d === 1 ? r.up : -r.down) : d === 1 ? (r.up1 ?? NaN) : -(r.down1 ?? NaN);
  return DIRECTION_EXIT_K_GRID.map((k) => {
    let n = 0;
    let touch = 0;
    let finish = 0;
    let rn = 0;
    let rTouch = 0;
    let rFinish = 0;
    for (const { r, d } of calls) {
      const f = outcome(r, lag);
      if (f === null || r.atrPct === null) continue;
      n++;
      if (mfe(r, d) >= k * r.atrPct) touch++;
      if (d * f >= k * r.atrPct) finish++;
      const pool = poolOf(r);
      for (let j = 0; j < DIRECTION_EXIT_RANDOM_DRAWS && pool.length > 0; j++) {
        const q = pool[Math.floor(random() * pool.length)];
        const fq = outcome(q, lag);
        if (fq === null || q.atrPct === null) continue;
        rn++;
        if (mfe(q, d) >= k * q.atrPct) rTouch++;
        if (d * fq >= k * q.atrPct) rFinish++;
      }
    }
    return { k, callTouch: n ? touch / n : 0, callFinish: n ? finish / n : 0, randomTouch: rn ? rTouch / rn : 0, randomFinish: rn ? rFinish / rn : 0 };
  });
}

export function diagnose(rows: DxRow[], interval: string, costPercent: number, lag: 0 | 1): DiagnosisReport {
  const cell = rows.filter((r) => r.interval === interval);
  const calls = cell.flatMap((r) => {
    const d = directionOf(r.tier);
    return d === 0 ? [] : [{ r, d: d as 1 | -1 }];
  });
  const overall = pointMeasures(measured(calls.map((c) => c.r), lag, (r) => r.tier), costPercent);
  const categories = CATEGORIES.map((c) => {
    const withCat = calls.filter(({ r }) => r.cats[c] !== null && r.cats[c] !== 0);
    const agree = withCat.filter(({ r, d }) => Math.sign(r.cats[c] as number) === d).length;
    const asDirection = pointMeasures(
      measured(withCat.map((x) => x.r), lag, (r) => ((r.cats[c] as number) > 0 ? 'buy' : 'sell')),
      costPercent
    );
    return { category: c, agreeShare: withCat.length ? agree / withCat.length : null, bh: asDirection.bh, n: withCat.length };
  });
  const volTop = volTopThresholds(cell);
  const conditions = (['C1', 'C2', 'C3', 'C4'] as const).map((id) => {
    const holds = calls.filter(({ r, d }) => conditionHolds(id, r, d, volTop)).map((x) => x.r);
    const fails = calls.filter(({ r, d }) => !conditionHolds(id, r, d, volTop)).map((x) => x.r);
    return {
      id,
      holds: pointMeasures(measured(holds, lag, (r) => r.tier), costPercent),
      fails: pointMeasures(measured(fails, lag, (r) => r.tier), costPercent),
      coverage: calls.length ? holds.length / calls.length : 0,
    };
  });
  // A4 at lag 1 (note N1), over every row of the cell, calls or not.
  const signs = Object.fromEntries(
    CATEGORIES.map((c) => {
      const x: number[] = [];
      const y: number[] = [];
      for (const r of cell) {
        if (r.cats[c] === null || r.fwd1 === null) continue;
        x.push(r.cats[c] as number);
        y.push(r.fwd1);
      }
      const ic = x.length > 2 ? spearman(x, y) : 0;
      return [c, !Number.isFinite(ic) || ic >= 0 ? 1 : -1];
    })
  ) as DirectionExitFit['signs'];
  const d1 = cell.map((r) => d1Score(r.cats, signs)).filter((v): v is number => v !== null).map(Math.abs);
  const callShare = cell.filter((r) => directionOf(r.tier) !== 0).length / Math.max(1, cell.length);
  const threshold = d1.length > 0 ? quantile(d1, 1 - callShare) : Infinity;
  return {
    interval, calls: calls.length, lag, overall, categories, conditions,
    paths: pathStats(cell, calls, lag),
    fit: { signs, threshold, volTopThreshold: volTop },
  };
}

interface DiagnosisArgs { rows: string; out: string }

export function parseArgs(argv: string[]): DiagnosisArgs {
  const args: Partial<DiagnosisArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--rows') args.rows = v;
    else if (flag === '--out') args.out = v;
    else throw new Error(`Unknown flag "${flag}"`);
  }
  if (!args.rows) throw new Error('--rows is required');
  if (!args.out) throw new Error('--out is required');
  return args as DiagnosisArgs;
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    const gz = readFileSync(args.rows);
    const rowsSha256 = createHash('sha256').update(gz).digest('hex');
    const rows = gunzipSync(gz)
      .toString('utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as DxRow);
    const intervals = [...new Set(rows.map((r) => r.interval))].sort();
    const reports: DiagnosisReport[] = [];
    for (const interval of intervals) {
      for (const lag of [0, 1] as const) reports.push(diagnose(rows, interval, defaultCostPercent(interval), lag));
    }
    writeFileSync(args.out, JSON.stringify({ reports, rowsSha256 }, null, 2));
    for (const r of reports.filter((x) => x.lag === 1)) console.log(JSON.stringify({ interval: r.interval, fit: r.fit }));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

if (require.main === module) main();
