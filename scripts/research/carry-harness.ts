/**
 * CLI for the funding carry test pre-registered in carry-sim.ts's header.
 *
 * Reads spot 1h candles, perp 1h klines and per-settlement funding from a
 * dataset export (lockbox applied), runs R0 and the six R1 cells through the
 * seven pre-registered walk-forward windows under the taker cost, and writes a
 * schema-validated report with every pre-registered statistic, the kill
 * criterion's gates, R1's timing null, the leverage tables and the
 * feasibility table.
 *
 * Usage:
 *   npx tsx scripts/research/carry-harness.ts --dataset-dir <dir> [--symbols A,B] [--out <file>] [--task-id <id>]
 *
 * The kill criterion is evaluated for each rule. The carry hypothesis is
 * rejected when it fires for every rule; a rule that survives is reported as
 * such, and R1 counts as timing only under its own stricter test.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { VENUE_FILTERS } from '@/lib/trade-plan/venue';
import { loadCandles, loadFunding, loadManifest, loadPerp } from './load-dataset';
import type { CandleRow, FundingRow, PerpCandleRow } from './dataset-format';
import {
  CARRY_COST_BNB,
  CARRY_COST_MAKER,
  CARRY_COST_TAKER,
  CARRY_TRIALS,
  annualStat,
  annualised,
  feasibility,
  leverageTable,
  periodAnnuals,
  pooledDaily,
  ruleLabel,
  runBook,
  timingNull,
  walkForward,
  type AnnualStat,
  type CarrySymbolInput,
  type CostProfile,
  type WalkForwardWindow,
} from './carry-sim';
import { evaluateCarryRule, evaluateR1Timing } from './carry-gates';
import { validateCarryReport, type CarryReport } from './report-schema';

export interface CarryArgs {
  datasetDir: string;
  symbols: string[];
  out: string;
  taskId: string;
}

export function parseArgs(argv: string[]): CarryArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    const key = flag.slice(2);
    if (!['dataset-dir', 'symbols', 'out', 'task-id'].includes(key)) throw new Error(`Unknown flag ${flag}`);
    flags.set(key, value);
    i++;
  }
  const taskId = flags.get('task-id') ?? 'carry';
  return {
    datasetDir: flags.get('dataset-dir') ?? 'data/research',
    symbols: flags.has('symbols')
      ? flags
          .get('symbols')!
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [...SIGNAL_SYMBOLS],
    out: flags.get('out') ?? `data/research/reports/carry-${taskId}.json`,
    taskId,
  };
}

/** One symbol on the 1h bars its spot and perp series share, with its settlements. */
export function buildCarryInput(
  symbol: string,
  spot: CandleRow[],
  perp: PerpCandleRow[],
  funding: FundingRow[]
): CarrySymbolInput {
  const perpByT = new Map(perp.map((p) => [p.t, p]));
  const t: number[] = [];
  const spotClose: number[] = [];
  const perpClose: number[] = [];
  const perpHigh: number[] = [];
  for (const s of spot) {
    const p = perpByT.get(s.t);
    if (!p || !(s.c > 0) || !(p.c > 0)) continue;
    t.push(s.t);
    spotClose.push(s.c);
    perpClose.push(p.c);
    perpHigh.push(p.h);
  }
  const settlements = funding
    .filter((f) => Number.isFinite(f.rate))
    .map((f) => ({ t: f.t, rate: f.rate }))
    .sort((a, b) => a.t - b.t);
  return { symbol, t, spotClose, perpClose, perpHigh, settlements };
}

const finiteOrNull = (v: number) => (Number.isFinite(v) ? v : null);

function statJson(stat: AnnualStat) {
  return { annual: finiteOrNull(stat.annual), ciLow: finiteOrNull(stat.ciLow), ciHigh: finiteOrNull(stat.ciHigh), days: stat.days };
}

/** Per-symbol daily series of one rule, windows concatenated. */
function perSymbolDaily(windows: WalkForwardWindow[], which: 'r0' | 'r1', symbol: string): number[] {
  return windows.flatMap((w) => w[which].perSymbol[symbol] ?? []);
}

/** The same rules, re-run under another cost, the R1 cells held at the taker run's selection. */
function underCost(inputs: CarrySymbolInput[], windows: WalkForwardWindow[], which: 'r0' | 'r1', cost: CostProfile): number {
  const daily: number[] = [];
  for (const w of windows) {
    const rule = which === 'r0' ? ({ kind: 'always' } as const) : w.r1Selected;
    daily.push(...runBook(inputs, rule, w.window.testFrom, w.window.testTo, cost).daily);
  }
  return annualised(daily);
}

function ruleResult(inputs: CarrySymbolInput[], windows: WalkForwardWindow[], which: 'r0' | 'r1', blockDays: number) {
  const { days, daily } = pooledDaily(windows, which);
  const stat = annualStat(daily, blockDays);
  const periods = periodAnnuals(days, daily);
  const verdict = evaluateCarryRule(stat, periods);
  const totalDays = daily.length;
  const funding = windows.reduce((s, w) => s + w[which].funding, 0);
  const cost = windows.reduce((s, w) => s + w[which].cost, 0);
  const perSymbolAnnual: Record<string, number | null> = {};
  const jackknifeAnnual: Record<string, number | null> = {};
  const n = inputs.length;
  for (const input of inputs) {
    const own = perSymbolDaily(windows, which, input.symbol);
    perSymbolAnnual[input.symbol] = finiteOrNull(annualised(own));
    if (n > 1) {
      const without = daily.map((d, k) => (d * n - (own[k] ?? 0)) / (n - 1));
      jackknifeAnnual[input.symbol] = finiteOrNull(annualised(without));
    }
  }
  return {
    rule: which === 'r0' ? 'R0 always' : windows.map((w) => ruleLabel(w.r1Selected)).join(' | '),
    stat: statJson(stat),
    statBlock10: statJson(annualStat(daily, 10)),
    statBlock40: statJson(annualStat(daily, 40)),
    periods: periods.map((p) => ({ label: p.label, annual: finiteOrNull(p.annual), days: p.days })),
    gates: verdict.gates.map((g) => ({ ...g, value: finiteOrNull(g.value) })),
    killed: verdict.killed,
    fundingAnnual: totalDays > 0 ? finiteOrNull((funding / totalDays) * 365) : null,
    costAnnual: totalDays > 0 ? finiteOrNull((cost / totalDays) * 365) : null,
    perSymbolAnnual,
    jackknifeAnnual,
    costRows: [
      { profile: CARRY_COST_TAKER.name, annual: finiteOrNull(stat.annual) },
      { profile: CARRY_COST_MAKER.name, annual: finiteOrNull(underCost(inputs, windows, which, CARRY_COST_MAKER)) },
      { profile: CARRY_COST_BNB.name, annual: finiteOrNull(underCost(inputs, windows, which, CARRY_COST_BNB)) },
    ],
    leverage: leverageTable(inputs, windows, which, CARRY_COST_TAKER).map((row) => ({
      ...row,
      annualOnCapital: finiteOrNull(row.annualOnCapital),
      liquidationCostAnnual: finiteOrNull(row.liquidationCostAnnual),
    })),
  };
}

function resolveCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export function runCarry(args: CarryArgs): CarryReport {
  const started = Date.now();
  const manifest = loadManifest(args.datasetDir);
  let lockboxApplied = true;
  const inputs: CarrySymbolInput[] = [];
  for (const symbol of args.symbols) {
    const spot = loadCandles(args.datasetDir, symbol, '1h');
    const perp = loadPerp(args.datasetDir, symbol, '1h');
    const funding = loadFunding(args.datasetDir, symbol);
    lockboxApplied = lockboxApplied && spot.lockboxApplied && perp.lockboxApplied && funding.lockboxApplied;
    inputs.push(buildCarryInput(symbol, spot.rows, perp.rows, funding.rows));
  }

  const windows = walkForward(inputs, CARRY_COST_TAKER);
  const episodes = windows.flatMap((w) => w.r1.episodes);
  const meanEpisodeDays = episodes.length > 0 ? episodes.reduce((a, b) => a + b, 0) / episodes.length / 24 : 0;
  const meanBlockLenDays = Math.max(meanEpisodeDays, 20);

  const r0 = ruleResult(inputs, windows, 'r0', meanBlockLenDays);
  const r1 = ruleResult(inputs, windows, 'r1', meanBlockLenDays);

  const pr0 = pooledDaily(windows, 'r0');
  const pr1 = pooledDaily(windows, 'r1');
  const difference = annualStat(
    pr1.daily.map((d, k) => d - pr0.daily[k]),
    meanBlockLenDays
  );
  const draws = 200;
  const timing = timingNull(inputs, windows, CARRY_COST_TAKER, draws);
  const timingVerdict = evaluateR1Timing(difference, timing.p);

  const feasibilityRows = inputs.flatMap((input) => {
    const venue = VENUE_FILTERS[input.symbol];
    const price = input.perpClose[input.perpClose.length - 1];
    if (!venue || !(price > 0)) return [];
    return [100, 500, 1000].map((capital) => feasibility(input.symbol, price, capital, venue, inputs.length));
  });

  const report: CarryReport = {
    schemaVersion: 1,
    taskId: args.taskId,
    datasetManifestHash: manifest.datasetHash,
    lockboxApplied,
    symbols: inputs.map((i) => i.symbol),
    trials: CARRY_TRIALS,
    costPerSide: CARRY_COST_TAKER.perSide,
    meanBlockLenDays,
    windows: windows.map((w) => ({
      testFrom: w.window.testFrom,
      testTo: w.window.testTo,
      trainFrom: w.window.trainFrom,
      trainTo: w.window.trainTo,
      r1Selected: ruleLabel(w.r1Selected),
      r1TrainAnnual: finiteOrNull(w.r1TrainAnnual),
      r0Annual: finiteOrNull(annualised(w.r0.daily)),
      r1Annual: finiteOrNull(annualised(w.r1.daily)),
    })),
    r0,
    r1,
    r1VsR0: statJson(difference),
    timing: { p: timing.p, observed: finiteOrNull(timing.observed), nullMean: finiteOrNull(timing.nullMean), draws },
    r1IsTimingFinding: timingVerdict.isTimingFinding,
    feasibility: feasibilityRows,
    killCriterionFires: r0.killed && r1.killed,
    computedAt: new Date().toISOString(),
    gitCommit: resolveCommit(),
    durationMs: Date.now() - started,
  };

  const validated = validateCarryReport(report);
  if (!validated.ok) throw new Error(`Carry report failed its schema: ${validated.issues.join('; ')}`);
  return validated.data;
}

const pct = (v: number | null, digits = 2) => (v === null ? '-' : `${(v * 100).toFixed(digits)}%`);

export function formatCarry(report: CarryReport): string {
  const lines: string[] = [];
  lines.push(
    `carry: ${report.symbols.length} symbols, trials ${report.trials}, cost ${pct(report.costPerSide, 3)} a side, ` +
      `block ${report.meanBlockLenDays.toFixed(1)}d, lockbox ${report.lockboxApplied}, dataset ${report.datasetManifestHash.slice(0, 12)}`
  );
  for (const [name, r] of [
    ['R0', report.r0],
    ['R1', report.r1],
  ] as const) {
    lines.push(
      `${name}  annual ${pct(r.stat.annual)}  CI [${pct(r.stat.ciLow)}, ${pct(r.stat.ciHigh)}]  ` +
        `funding ${pct(r.fundingAnnual)}  cost ${pct(r.costAnnual)}  killed ${r.killed}`
    );
    lines.push(`    periods ${r.periods.map((p) => `${p.label} ${pct(p.annual)}`).join(', ')}`);
    lines.push(`    gates ${r.gates.map((g) => `${g.name} ${g.pass ? 'pass' : 'FAIL'}`).join(', ')}`);
    lines.push(`    cost rows ${r.costRows.map((c) => `${c.profile} ${pct(c.annual)}`).join(', ')}`);
    lines.push(
      `    per symbol ${Object.entries(r.perSymbolAnnual)
        .map(([s, v]) => `${s.replace('USDT', '')} ${pct(v, 1)}`)
        .join(' ')}`
    );
    lines.push(
      `    leverage ${r.leverage
        .map((l) => `${l.leverage}x ${pct(l.annualOnCapital)} liq ${l.liquidations}`)
        .join(', ')}`
    );
  }
  lines.push(
    `R1 - R0  ${pct(report.r1VsR0.annual)}  CI [${pct(report.r1VsR0.ciLow)}, ${pct(report.r1VsR0.ciHigh)}]  ` +
      `timing p ${report.timing.p.toFixed(3)}  timing finding ${report.r1IsTimingFinding}`
  );
  lines.push(`KILL CRITERION FIRES: ${report.killCriterionFires}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = runCarry(args);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(formatCarry(report));
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
