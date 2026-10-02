/**
 * CLI for the legends phase trend set pre-registered in trend-sim.ts's header
 * (TF1 to TF4 and C3, the exposure rules).
 *
 * Reads spot 1d candles (PRIMARY prices and every sample's warmup), perp 1d
 * klines (CONSISTENCY), per-settlement funding, 1d snapshots (each symbol's
 * listing: its first funding row) and 4h snapshots (the funding fallback
 * before a symbol's first archived settlement) from a dataset export, lockbox
 * applied. Runs one rule and its always-long twin through every gated and
 * reported statistic and writes a schema-validated report.
 *
 * Usage:
 *   npx tsx scripts/research/trend-harness.ts --rule TF1 --dataset-dir <dir> [--symbols A,B] [--out <file>] [--task-id <id>] [--draws 200]
 *
 * Gate 8 is left pending: it is computed once across all eleven trials.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { LOCKBOX_START, type CandleRow, type FundingRow, type PerpCandleRow, type SnapshotRow } from './dataset-format';
import { loadCandles, loadFunding, loadManifest, loadPerp, loadSnapshots } from './load-dataset';
import {
  DAY_MS,
  TREND_RULE_IDS,
  c3Paths,
  c3State,
  tf1Paths,
  tf2Paths,
  tf3Paths,
  tf4Paths,
  twinOf,
  type RulePaths,
  type TrendRuleId,
} from './trend-signals';
import {
  TREND_COST,
  alphaCi,
  annualAlpha,
  annualMean,
  annualisedSharpe,
  liveRange,
  losingStreak,
  maxDrawdown,
  runTrend,
  sharpeCi,
  stressCost,
  timingNull,
  topEpisodeShare,
  utcDay,
  yearAlphas,
  type CiStat,
  type Settlement,
  type SimOptions,
  type TrendRun,
  type TrendSymbolInput,
} from './trend-sim';
import { evaluateTrendGates, trendVerdict } from './trend-gates';
import { validateTrendReport, type TrendReport } from './report-schema';

/** PRIMARY: from the first funding row (BTCUSDT, 2019-09-11) to the lockbox. */
export const PRIMARY_FROM = Date.UTC(2019, 8, 11);
/** CONSISTENCY: perp closes from 2022-01-01 to the lockbox. */
export const CONSISTENCY_FROM = Date.UTC(2022, 0, 1);
/** Gate 2 and 3 block length and their sensitivities, days. */
export const BLOCK_DAYS = 60;
export const BLOCK_SENSITIVITY = [20, 120] as const;
const REPORT_YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const FUNDING_STEP_MS = 8 * 3_600_000;

export interface TrendArgs {
  rule: TrendRuleId;
  datasetDir: string;
  symbols: string[];
  out: string;
  taskId: string;
  draws: number;
}

export function parseArgs(argv: string[]): TrendArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    const key = flag.slice(2);
    if (!['rule', 'dataset-dir', 'symbols', 'out', 'task-id', 'draws'].includes(key)) throw new Error(`Unknown flag ${flag}`);
    flags.set(key, value);
    i++;
  }
  const rule = flags.get('rule');
  if (!rule || !(TREND_RULE_IDS as readonly string[]).includes(rule)) {
    throw new Error(`--rule must be one of ${TREND_RULE_IDS.join(', ')}`);
  }
  const draws = Number(flags.get('draws') ?? '200');
  if (!Number.isInteger(draws) || draws < 1) throw new Error('--draws must be a positive integer');
  const taskId = flags.get('task-id') ?? rule.toLowerCase();
  return {
    rule: rule as TrendRuleId,
    datasetDir: flags.get('dataset-dir') ?? 'data/research',
    symbols: flags.has('symbols')
      ? flags
          .get('symbols')!
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [...SIGNAL_SYMBOLS],
    out: flags.get('out') ?? `data/research/reports/trend-${taskId}.json`,
    taskId,
    draws,
  };
}

/** The open time of the first 1d snapshot carrying a funding rate: the perp listing. */
export function listingDayOf(symbol: string, snapshots1d: SnapshotRow[]): number {
  const first = snapshots1d.find((row) => row.fundingRate !== null && Number.isFinite(row.fundingRate.rate));
  if (!first) throw new Error(`${symbol}: no 1d snapshot carries a funding rate`);
  return utcDay(first.t);
}

/**
 * The archive's settlements, preceded by the pre-registered fallback: every 8h
 * boundary from the listing day up to the first archived settlement, at the
 * last 4h snapshot rate at or before it (implementation note 1).
 */
export function buildSettlements(
  listingDay: number,
  archive: FundingRow[],
  snapshots4h: SnapshotRow[]
): { settlements: Settlement[]; fallback: number } {
  const archived = archive
    .filter((f) => Number.isFinite(f.rate))
    .map((f) => ({ t: f.t, rate: f.rate }))
    .sort((a, b) => a.t - b.t);
  const firstArchived = archived.length > 0 ? archived[0].t : Number.POSITIVE_INFINITY;
  const rated = snapshots4h
    .filter((row) => row.fundingRate !== null && Number.isFinite(row.fundingRate.rate))
    .sort((a, b) => a.t - b.t);
  const fallback: Settlement[] = [];
  let ptr = -1;
  for (let s = listingDay; s < firstArchived && s < LOCKBOX_START; s += FUNDING_STEP_MS) {
    while (ptr + 1 < rated.length && rated[ptr + 1].t <= s) ptr++;
    if (ptr >= 0) fallback.push({ t: s, rate: rated[ptr].fundingRate!.rate });
  }
  return { settlements: [...fallback, ...archived], fallback: fallback.length };
}

/**
 * Daily bars with every missing day inside the series filled by carrying the
 * last close forward (open = close = last close), so a lookback of L bars stays
 * L days and the move across a gap is booked on the day data resumes. No price
 * is invented. The perp series lacks 2022-02-26 to 02-28 and 2022-04-01 to
 * 04-02 on SOLUSDT and XRPUSDT at every interval (found 2026-10-02); the count
 * of filled days is reported.
 */
export function dailyInput(
  symbol: string,
  rows: Array<{ t: number; o: number; c: number }>,
  listingDay: number,
  settlements: Settlement[]
): { input: TrendSymbolInput; filled: number } {
  const kept = rows.filter((r) => r.o > 0 && r.c > 0).sort((a, b) => a.t - b.t);
  const t: number[] = [];
  const open: number[] = [];
  const close: number[] = [];
  let filled = 0;
  for (const r of kept) {
    while (t.length > 0 && r.t - t[t.length - 1] > DAY_MS) {
      const last = close[close.length - 1];
      t.push(t[t.length - 1] + DAY_MS);
      open.push(last);
      close.push(last);
      filled++;
    }
    t.push(r.t);
    open.push(r.o);
    close.push(r.c);
  }
  return { input: { symbol, t, open, close, listingDay, settlements }, filled };
}

/** Spot closes before `splice`, perp closes from it: the CONSISTENCY input with its spot warmup. */
export function splicedInput(
  symbol: string,
  spot: CandleRow[],
  perp: PerpCandleRow[],
  splice: number,
  listingDay: number,
  settlements: Settlement[]
): { input: TrendSymbolInput; filled: number } {
  const rows = [...spot.filter((r) => r.t < splice), ...perp.filter((r) => r.t >= splice)];
  return dailyInput(symbol, rows, listingDay, settlements);
}

/**
 * C3's basket: an equal-weight index of every symbol with closes on both the
 * day and the day before, chain-linked on the union of days; its state is
 * mapped back onto each symbol's own bars.
 */
export function c3PathsFor(inputs: TrendSymbolInput[]): Record<string, RulePaths> {
  const closeOf = inputs.map((input) => new Map(input.t.map((t, i) => [t, input.close[i]])));
  const allDays = [...new Set(inputs.flatMap((i) => i.t))].sort((a, b) => a - b);
  const index = new Float64Array(allDays.length);
  index[0] = 1;
  for (let k = 1; k < allDays.length; k++) {
    let sum = 0;
    let count = 0;
    for (const closes of closeOf) {
      const today = closes.get(allDays[k]);
      const before = closes.get(allDays[k] - DAY_MS);
      if (today !== undefined && before !== undefined && allDays[k - 1] === allDays[k] - DAY_MS) {
        sum += today / before - 1;
        count++;
      }
    }
    index[k] = index[k - 1] * (1 + (count > 0 ? sum / count : 0));
  }
  const state = c3State(index);
  const stateByDay = new Map(allDays.map((d, k) => [d, state[k]]));
  return Object.fromEntries(
    inputs.map((input) => [
      input.symbol,
      c3Paths(input.close, Float64Array.from(input.t.map((t) => stateByDay.get(t) ?? 0))),
    ])
  );
}

export function rulePaths(rule: TrendRuleId, inputs: TrendSymbolInput[]): Record<string, RulePaths> {
  if (rule === 'C3') return c3PathsFor(inputs);
  const build = { TF1: tf1Paths, TF2: tf2Paths, TF3: tf3Paths, TF4: tf4Paths }[rule];
  return Object.fromEntries(inputs.map((input) => [input.symbol, build(input.t, input.close)]));
}

function twinPaths(paths: Record<string, RulePaths>): Record<string, RulePaths> {
  return Object.fromEntries(Object.entries(paths).map(([s, p]) => [s, twinOf(p)]));
}

const finiteOrNull = (v: number) => (Number.isFinite(v) ? v : null);

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function summarise(run: TrendRun, range: { first: number; last: number }) {
  const slice = <T>(xs: T[]) => xs.slice(range.first, range.last + 1);
  const returns = slice(run.returns);
  const gross = slice(run.gross);
  const sortedGross = [...gross].sort((a, b) => a - b);
  const share = (x: number) => (gross.length > 0 ? gross.filter((g) => g > x).length / gross.length : Number.NaN);
  return {
    days: returns.length,
    sharpe: finiteOrNull(annualisedSharpe(returns)),
    annualReturn: finiteOrNull(annualMean(returns)),
    longLegAnnual: finiteOrNull(annualMean(slice(run.longLeg))),
    shortLegAnnual: finiteOrNull(annualMean(slice(run.shortLeg))),
    costAnnual: finiteOrNull(annualMean(slice(run.cost))),
    fundingAnnual: finiteOrNull(annualMean(slice(run.funding))),
    turnoverAnnual: finiteOrNull(annualMean(slice(run.turnover))),
    maxDrawdown: maxDrawdown(returns),
    gross: {
      mean: finiteOrNull(gross.reduce((a, b) => a + b, 0) / Math.max(1, gross.length)),
      p50: finiteOrNull(quantile(sortedGross, 0.5)),
      p95: finiteOrNull(quantile(sortedGross, 0.95)),
      max: finiteOrNull(sortedGross[sortedGross.length - 1] ?? Number.NaN),
      shareAbove1: finiteOrNull(share(1)),
      shareAbove2: finiteOrNull(share(2)),
      shareAbove3: finiteOrNull(share(3)),
    },
  };
}

function ciJson(ci: CiStat) {
  return { point: finiteOrNull(ci.point), low: finiteOrNull(ci.low), high: finiteOrNull(ci.high), blockLen: ci.blockLen };
}

/** T and T+ over one sample, aligned on the days any sleeve holds capital. */
export function pair(
  inputs: TrendSymbolInput[],
  rule: TrendRuleId,
  opts: SimOptions,
  paths = rulePaths(rule, inputs)
): { t: TrendRun; twin: TrendRun; range: { first: number; last: number }; paths: Record<string, RulePaths> } {
  const t = runTrend(inputs, paths, opts);
  const twin = runTrend(inputs, twinPaths(paths), opts);
  return { t, twin, range: liveRange(t), paths };
}

function pairPoint(p: ReturnType<typeof pair>) {
  const r = p.t.returns.slice(p.range.first, p.range.last + 1);
  const w = p.twin.returns.slice(p.range.first, p.range.last + 1);
  const { alpha, beta } = annualAlpha(r, w);
  return {
    alpha: finiteOrNull(alpha),
    beta: finiteOrNull(beta),
    sharpe: finiteOrNull(annualisedSharpe(r)),
    twinSharpe: finiteOrNull(annualisedSharpe(w)),
  };
}

function resolveCommit(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export interface TrendInputs {
  primary: TrendSymbolInput[];
  perp: TrendSymbolInput[];
  fallback: Record<string, number>;
  /** Days filled by carrying the last close, per symbol and sample. */
  filledDays: Record<string, { primary: number; perp: number }>;
  lockboxApplied: boolean;
}

export function loadTrendInputs(datasetDir: string, symbols: string[]): TrendInputs {
  let lockboxApplied = true;
  const primary: TrendSymbolInput[] = [];
  const perpInputs: TrendSymbolInput[] = [];
  const fallback: Record<string, number> = {};
  const filledDays: Record<string, { primary: number; perp: number }> = {};
  for (const symbol of symbols) {
    const spot = loadCandles(datasetDir, symbol, '1d');
    const perp = loadPerp(datasetDir, symbol, '1d');
    const funding = loadFunding(datasetDir, symbol);
    const snap1d = loadSnapshots(datasetDir, symbol, '1d');
    const snap4h = loadSnapshots(datasetDir, symbol, '4h');
    lockboxApplied =
      lockboxApplied &&
      spot.lockboxApplied &&
      perp.lockboxApplied &&
      funding.lockboxApplied &&
      snap1d.lockboxApplied &&
      snap4h.lockboxApplied;
    const listingDay = listingDayOf(symbol, snap1d.rows);
    const { settlements, fallback: count } = buildSettlements(listingDay, funding.rows, snap4h.rows);
    fallback[symbol] = count;
    const spotInput = dailyInput(symbol, spot.rows, listingDay, settlements);
    const perpInput = splicedInput(symbol, spot.rows, perp.rows, CONSISTENCY_FROM, listingDay, settlements);
    primary.push(spotInput.input);
    perpInputs.push(perpInput.input);
    filledDays[symbol] = { primary: spotInput.filled, perp: perpInput.filled };
  }
  return { primary, perp: perpInputs, fallback, filledDays, lockboxApplied };
}

export function runTrendStudy(args: TrendArgs, loaded?: TrendInputs, datasetHash?: string): TrendReport {
  const started = Date.now();
  const hash = datasetHash ?? loadManifest(args.datasetDir).datasetHash;
  const inputs = loaded ?? loadTrendInputs(args.datasetDir, args.symbols);
  const base: SimOptions = { from: PRIMARY_FROM, to: LOCKBOX_START, cost: TREND_COST, delay: 0 };

  const primary = pair(inputs.primary, args.rule, base);
  const { range } = primary;
  const tR = primary.t.returns.slice(range.first, range.last + 1);
  const twinR = primary.twin.returns.slice(range.first, range.last + 1);
  const days = primary.t.days.slice(range.first, range.last + 1);

  const sharpe = sharpeCi(tR, { blockLen: BLOCK_DAYS });
  const alpha = alphaCi(tR, twinR, { blockLen: BLOCK_DAYS });
  const { beta } = annualAlpha(tR, twinR);

  const timing = timingNull(inputs.primary, primary.paths, primary.twin.returns, alpha.point, base, range, args.draws);

  // Gate 5 drops a sleeve, not a signal input: C3's basket keeps all ten.
  const dropOne: Record<string, number> = {};
  for (const input of inputs.primary) {
    const rest = inputs.primary.filter((i) => i !== input);
    dropOne[input.symbol] = pairPoint(pair(rest, args.rule, base, primary.paths)).alpha ?? Number.NaN;
  }

  const years = yearAlphas(days, tR, twinR, REPORT_YEARS);
  const stress = pairPoint(pair(inputs.primary, args.rule, { ...base, cost: stressCost(TREND_COST) }, primary.paths));
  const delay1 = pairPoint(pair(inputs.primary, args.rule, { ...base, delay: 1 }, primary.paths));

  const consOpts: SimOptions = { ...base, from: CONSISTENCY_FROM };
  const consPerp = pair(inputs.perp, args.rule, consOpts);
  const consSpot = pair(inputs.primary, args.rule, consOpts, primary.paths);
  const perpPoint = pairPoint(consPerp);
  const spotPoint = pairPoint(consSpot);

  const ep = topEpisodeShare(primary.t.episodes);
  const streak = losingStreak(primary.t.episodes);

  const perSymbol: TrendReport['perSymbol'] = {};
  for (const input of inputs.primary) {
    const own = primary.t.sleeveReturns[input.symbol].filter(Number.isFinite);
    const twinOwn = primary.twin.sleeveReturns[input.symbol].filter(Number.isFinite);
    perSymbol[input.symbol] = {
      sharpe: finiteOrNull(annualisedSharpe(own)),
      annual: finiteOrNull(annualMean(own)),
      twinSharpe: finiteOrNull(annualisedSharpe(twinOwn)),
      twinAnnual: finiteOrNull(annualMean(twinOwn)),
    };
  }

  const gates = evaluateTrendGates({
    sampleDays: tR.length,
    sharpeCiLow: sharpe.low,
    alphaCiLow: alpha.low,
    timingP: timing.p,
    dropOneAlphas: dropOne,
    yearAlphas: years,
    stressAlpha: stress.alpha ?? Number.NaN,
    consistencyAlpha: perpPoint.alpha ?? Number.NaN,
  });

  const twinSharpe = annualisedSharpe(twinR);
  const report: TrendReport = {
    schemaVersion: 1,
    taskId: args.taskId,
    rule: args.rule,
    datasetManifestHash: hash,
    lockboxApplied: inputs.lockboxApplied,
    symbols: inputs.primary.map((i) => i.symbol),
    cost: { fee: TREND_COST.fee, slippage: TREND_COST.slippage },
    sample: { from: base.from, to: base.to, firstDay: days[0], lastDay: days[days.length - 1], days: days.length },
    startDays: primary.t.startDay,
    fallbackSettlements: inputs.fallback,
    filledDays: inputs.filledDays,
    run: summarise(primary.t, range),
    twin: summarise(primary.twin, range),
    sharpe: ciJson(sharpe),
    sharpeBlock20: ciJson(sharpeCi(tR, { blockLen: BLOCK_SENSITIVITY[0] })),
    sharpeBlock120: ciJson(sharpeCi(tR, { blockLen: BLOCK_SENSITIVITY[1] })),
    sharpeDifference: finiteOrNull(sharpe.point - twinSharpe),
    alpha: ciJson(alpha),
    alphaBlock20: ciJson(alphaCi(tR, twinR, { blockLen: BLOCK_SENSITIVITY[0] })),
    alphaBlock120: ciJson(alphaCi(tR, twinR, { blockLen: BLOCK_SENSITIVITY[1] })),
    beta: finiteOrNull(beta),
    timing: { p: timing.p, nullMean: finiteOrNull(timing.nullMean), draws: timing.draws },
    dropOne: Object.fromEntries(Object.entries(dropOne).map(([s, a]) => [s, finiteOrNull(a)])),
    years: years.map((y) => ({ year: y.year, alpha: finiteOrNull(y.alpha), days: y.days })),
    stress,
    delay1,
    consistency: {
      from: CONSISTENCY_FROM,
      days: consPerp.range.last - consPerp.range.first + 1,
      perp: perpPoint,
      spot: spotPoint,
      spotMinusPerpAlpha:
        perpPoint.alpha !== null && spotPoint.alpha !== null ? spotPoint.alpha - perpPoint.alpha : null,
    },
    episodes: {
      count: primary.t.episodes.length,
      topShare: finiteOrNull(ep.share),
      topSum: ep.top,
      total: ep.total,
      longestLosingStreak: streak.longest,
      expectedLongestLosingStreak: finiteOrNull(streak.expected),
      lossRate: finiteOrNull(streak.lossRate),
    },
    perSymbol,
    gates,
    verdict: trendVerdict(gates),
    daily: { days, returns: tR },
    computedAt: new Date().toISOString(),
    gitCommit: resolveCommit(),
    durationMs: Date.now() - started,
  };

  const validated = validateTrendReport(report);
  if (!validated.ok) throw new Error(`Trend report failed its schema: ${validated.issues.join('; ')}`);
  return validated.data;
}

const pct = (v: number | null, digits = 2) => (v === null ? '-' : `${(v * 100).toFixed(digits)}%`);
const num = (v: number | null, digits = 2) => (v === null ? '-' : v.toFixed(digits));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function formatTrend(r: TrendReport): string {
  const lines: string[] = [];
  lines.push(
    `${r.rule}: ${r.symbols.length} symbols, ${iso(r.sample.firstDay)} to ${iso(r.sample.lastDay)} (${r.sample.days} days), ` +
      `cost ${pct(r.cost.fee + r.cost.slippage, 3)} a side, lockbox ${r.lockboxApplied}, dataset ${r.datasetManifestHash.slice(0, 12)}`
  );
  lines.push(
    `T   Sharpe ${num(r.sharpe.point)} CI [${num(r.sharpe.low)}, ${num(r.sharpe.high)}]  annual ${pct(r.run.annualReturn)}  ` +
      `long ${pct(r.run.longLegAnnual)} short ${pct(r.run.shortLegAnnual)} cost ${pct(r.run.costAnnual)} funding ${pct(r.run.fundingAnnual)}  ` +
      `maxDD ${pct(r.run.maxDrawdown, 1)} turnover ${num(r.run.turnoverAnnual, 1)}x gross ${num(r.run.gross.mean)}`
  );
  lines.push(
    `T+  Sharpe ${num(r.twin.sharpe)}  annual ${pct(r.twin.annualReturn)}  maxDD ${pct(r.twin.maxDrawdown, 1)}  ` +
      `Sharpe difference ${num(r.sharpeDifference)}`
  );
  lines.push(
    `alpha ${pct(r.alpha.point)} CI [${pct(r.alpha.low)}, ${pct(r.alpha.high)}]  beta ${num(r.beta)}  ` +
      `timing p ${r.timing.p.toFixed(3)} (null mean ${pct(r.timing.nullMean)})`
  );
  lines.push(
    `sensitivity: Sharpe CI 20d [${num(r.sharpeBlock20.low)}, ${num(r.sharpeBlock20.high)}] 120d [${num(r.sharpeBlock120.low)}, ${num(r.sharpeBlock120.high)}]; ` +
      `alpha CI 20d [${pct(r.alphaBlock20.low)}, ${pct(r.alphaBlock20.high)}] 120d [${pct(r.alphaBlock120.low)}, ${pct(r.alphaBlock120.high)}]`
  );
  lines.push(`years ${r.years.map((y) => `${y.year} ${pct(y.alpha, 1)}`).join(', ')}`);
  lines.push(`drop-one ${Object.entries(r.dropOne).map(([s, a]) => `${s.replace('USDT', '')} ${pct(a, 1)}`).join(' ')}`);
  lines.push(
    `stress alpha ${pct(r.stress.alpha)}; delay 1 alpha ${pct(r.delay1.alpha)} Sharpe ${num(r.delay1.sharpe)}; ` +
      `consistency perp alpha ${pct(r.consistency.perp.alpha)} Sharpe ${num(r.consistency.perp.sharpe)}, spot alpha ${pct(r.consistency.spot.alpha)}, ` +
      `spot - perp ${pct(r.consistency.spotMinusPerpAlpha)}`
  );
  lines.push(
    `episodes ${r.episodes.count}, top 15% share ${num(r.episodes.topShare)}, losing streak ${r.episodes.longestLosingStreak} ` +
      `(expected ${num(r.episodes.expectedLongestLosingStreak, 1)})`
  );
  lines.push(`gates ${r.gates.map((g) => `${g.id} ${g.name} ${g.pass === null ? 'PENDING' : g.pass ? 'pass' : 'FAIL'}`).join(', ')}`);
  lines.push(`VERDICT ${r.verdict}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = runTrendStudy(args);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(formatTrend(report));
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
