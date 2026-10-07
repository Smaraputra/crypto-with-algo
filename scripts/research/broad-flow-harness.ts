/**
 * CLI for the broad flow phase pre-registered in broad-flow.ts's header: one rule (the trials DO, W, WO, or the
 * daily raw control D) on the broad trend phase's point-in-time top-50 universe of Binance USDT-M perpetuals,
 * through every gated and reported statistic, into a schema v3 report (report-schema.ts BroadFlowReportSchema).
 *
 * Reads a hash-verified export and a universe file built from it (broad-inputs.ts, plus each member's traded
 * bars for the volumes), lockbox applied. The book runs in the broad container (trend-sim.ts broad mode) with
 * re-equalisation at every decision close (SimOptions.reequaliseAt); costs are the broad phase's: the taker fee
 * (BROAD_FEE) plus the rank-tiered slippage, the leave slippage and the delisting haircut (BROAD_COST).
 *
 * Usage:
 *   npx tsx scripts/research/broad-flow-harness.ts --rule DO --dataset-dir <export> --universe-file <universe.json> \
 *     --out <report.json> --task-id <id> [--draws 200] \
 *     [--funding-resolutions <resolutions.json>] [--funding-check-out <flagged.json>]
 *
 * The funding flags are broad-harness.ts's (broad-trend.ts implementation note A6-1): the recorded resolutions of
 * settlements the coverage check flags, and where to write the flagged list when the check stops the run.
 *
 * Gate 7 is left pending: broad-flow-dsr.ts computes it once across the three trial reports. The choices the
 * header leaves open are recorded in broad-flow.ts's implementation notes (F1 to F17).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import {
  FLOW_CALENDAR,
  FLOW_RULES,
  FLOW_RULE_IDS,
  MIN_FIT_PAIRS,
  MIN_QUINTILE,
  MIN_SHIFT_WEEKS,
  QUINTILES,
  STANDARDISE_MIN_DEFINED,
  STANDARDISE_WINDOW,
  WEEK_MIN_TRADED_DAYS,
  buildFlowInputs,
  firstPositionIndex,
  flowNull,
  flowSchedule,
  flowSimOptions,
  flowValues,
  lagValueAt,
  plainValueAt,
  rankBook,
  sectionsOf,
  unrankedShare,
  type FlowCalendar,
  type FlowInputs,
  type FlowNullResult,
  type FlowRuleId,
  type FlowSchedule,
  type ValueAt,
} from './broad-flow';
import {
  AFTER_PAPER_FROM,
  AFTER_PAPER_TO,
  FLOW_BLOCK_DAYS,
  FLOW_BLOCK_SENSITIVITY,
  FLOW_BOOT_DRAWS,
  FLOW_BOOT_SEED,
  FLOW_GATED_YEARS,
  FLOW_MIN_POSITIVE_YEAR_SHARE,
  FLOW_MIN_SAMPLE_DAYS,
  FLOW_NULL_DRAWS,
  FLOW_NULL_SEED,
  FLOW_REPORT_YEARS,
  FLOW_TIMING_P,
  PAPER_OVERLAP_FROM,
  PAPER_OVERLAP_TO,
  evaluateFlowGates,
  flowVerdict,
  meanOf,
  windowStats,
  yearStats,
} from './broad-flow-gates';
import {
  BTC_ETH_ASSETS,
  COHORT_MIN_SHARE,
  LEGENDS_TEN_ASSETS,
  STRESS_FEE_MULTIPLE,
  STRESS_REPORTED_HAIRCUT,
  contractsOfAssets,
  listingYearCohorts,
  topContributors,
} from './broad-gates';
import { assertInCalendar, broadOptions, btcBenchmark, memberBasketBenchmark, stressOptions } from './broad-harness';
import { readFundingResolutions, verifyUniverseFile, withFundingCheckOut } from './broad-inputs';
import { BROAD_COST, BROAD_FEE, DELIST_HAIRCUT, LEAVE_SLIPPAGE, SLIPPAGE_TIERS, isoDay } from './broad-trend';
import { loadFunding, loadManifest, loadPerp, verifyManifest } from './load-dataset';
import { validateBroadFlowReport, type BroadFlowReport } from './report-schema';
import { ciJson, resolveCommit, summarise } from './trend-harness';
import { DAY_MS } from './trend-signals';
import {
  MIN_SHIFT_DAYS,
  annualMean,
  annualisedSharpe,
  memberDays,
  runTrend,
  sharpeCi,
  stressBroad,
  type SimOptions,
  type TrendRun,
  type TrendSymbolInput,
} from './trend-sim';

export interface FlowArgs {
  rule: FlowRuleId;
  datasetDir: string;
  universeFile: string;
  out: string;
  taskId: string;
  draws: number;
  /** Recorded resolutions of flagged funding settlements (broad-trend.ts note A6-1). */
  fundingResolutions?: string;
  /** Where to write the full list of flagged settlements when the coverage check stops the run. */
  fundingCheckOut?: string;
}

const FLAGS = ['rule', 'dataset-dir', 'universe-file', 'out', 'task-id', 'draws', 'funding-resolutions', 'funding-check-out'];

export function parseArgs(argv: string[]): FlowArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    const key = flag.slice(2);
    if (!FLAGS.includes(key)) throw new Error(`Unknown flag ${flag}`);
    flags.set(key, value);
    i++;
  }
  const rule = flags.get('rule');
  if (!rule || !(FLOW_RULE_IDS as readonly string[]).includes(rule)) throw new Error(`--rule must be one of ${FLOW_RULE_IDS.join(', ')}`);
  for (const required of ['dataset-dir', 'universe-file', 'out', 'task-id']) {
    if (!flags.has(required)) throw new Error(`--${required} is required`);
  }
  const draws = Number(flags.get('draws') ?? String(FLOW_NULL_DRAWS));
  if (!Number.isInteger(draws) || draws < 1) throw new Error('--draws must be a positive integer');
  return {
    rule: rule as FlowRuleId,
    datasetDir: flags.get('dataset-dir')!,
    universeFile: flags.get('universe-file')!,
    out: flags.get('out')!,
    taskId: flags.get('task-id')!,
    draws,
    ...(flags.has('funding-resolutions') ? { fundingResolutions: flags.get('funding-resolutions')! } : {}),
    ...(flags.has('funding-check-out') ? { fundingCheckOut: flags.get('funding-check-out')! } : {}),
  };
}

/**
 * Verifies the export's manifest and the universe file against it (with the pre-registered parameters unless
 * `preregistered` is false, which only the tests pass), then builds the flow inputs from the export's 1d perp
 * klines and funding settlements (lockbox applied), as loadBroadInputs does.
 */
export async function loadFlowInputs(
  datasetDir: string,
  universePath: string,
  opts: { preregistered?: boolean; fundingResolutionsPath?: string; fundingCheckOut?: string } = {}
): Promise<FlowInputs> {
  const check = await verifyManifest(datasetDir);
  if (!check.ok) throw new Error(`Manifest verification failed: ${check.mismatches.join(', ')}`);
  const manifest = loadManifest(datasetDir);
  const universe = verifyUniverseFile(JSON.parse(readFileSync(universePath, 'utf8')), manifest.datasetHash, {
    preregistered: opts.preregistered ?? true,
  });
  const resolutions = opts.fundingResolutionsPath ? readFundingResolutions(opts.fundingResolutionsPath) : undefined;
  return withFundingCheckOut(opts.fundingCheckOut, () =>
    buildFlowInputs({
      datasetHash: manifest.datasetHash,
      universe,
      perp: (symbol) => loadPerp(datasetDir, symbol, '1d'),
      funding: (symbol) => loadFunding(datasetDir, symbol),
      resolutions,
    })
  );
}

const finiteOrNull = (v: number) => (Number.isFinite(v) ? v : null);

function slice<T>(xs: readonly T[], range: { first: number; last: number }): T[] {
  return xs.slice(range.first, range.last + 1);
}

/** Mean, Sharpe and annual return of a run over the range (gates 4, 6 and the reported points). */
export function runPoint(run: TrendRun, range: { first: number; last: number }) {
  const r = slice(run.returns, range);
  return {
    mean: finiteOrNull(meanOf(r)),
    sharpe: finiteOrNull(annualisedSharpe(r)),
    annualReturn: finiteOrNull(annualMean(r)),
  };
}

/** The book on `inputs` (a schedule over them, values unchanged), run in the container under `opts`. */
export function runBook(
  inputs: TrendSymbolInput[],
  frequency: FlowSchedule['frequency'],
  valueAt: (inputs: TrendSymbolInput[]) => ValueAt,
  opts: SimOptions
): { run: TrendRun; schedule: FlowSchedule; book: ReturnType<typeof rankBook> } {
  const schedule = flowSchedule(inputs, frequency, opts.from, opts.to);
  const book = rankBook(inputs, schedule, sectionsOf(schedule, inputs, valueAt(inputs)));
  return { run: runTrend(inputs, book.paths, opts), schedule, book };
}

/** Linear-interpolated quantile of an ascending array; NaN when empty. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = p * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper ? sorted[lower] : sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}

/** Mean, mean absolute value, 5th and 95th percentiles and maximum absolute value of a series. */
export function exposureStat(xs: readonly number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  let maxAbs = -Infinity;
  for (const x of xs) if (Math.abs(x) > maxAbs) maxAbs = Math.abs(x);
  return {
    mean: finiteOrNull(meanOf(xs)),
    meanAbs: finiteOrNull(meanOf(xs.map(Math.abs))),
    p05: finiteOrNull(quantile(sorted, 0.05)),
    p95: finiteOrNull(quantile(sorted, 0.95)),
    maxAbs: finiteOrNull(maxAbs),
  };
}

function median(xs: readonly number[]): number {
  return quantile([...xs].sort((a, b) => a - b), 0.5);
}

function nullJson(n: FlowNullResult, unit: 'days' | 'weeks' | null) {
  return {
    mode: n.mode,
    p: n.p,
    nullMean: finiteOrNull(n.nullMean),
    draws: n.draws,
    undefinedDraws: n.undefinedDraws,
    shiftUnit: n.mode === 'aligned' ? unit : null,
    shifts: n.shifts ?? [],
    outsideLifeShare: n.outsideLifeShare === undefined ? null : finiteOrNull(n.outsideLifeShare),
    unrankedShare: finiteOrNull(n.unrankedShare),
  };
}

export interface FlowStudyOptions {
  /** Draws of each null (200 pre-registered). */
  draws: number;
  /** Bootstrap draws (2,000 pre-registered); tests lower it. */
  bootstrapDraws?: number;
  calendar?: FlowCalendar;
  gitCommit?: string;
}

/**
 * The pure core the CLI wraps: one rule through every gate and reported statistic on loaded inputs. Throws on a
 * bar outside the null calendar before computing a return.
 */
export function runBroadFlowStudy(
  args: { rule: FlowRuleId; taskId: string },
  loaded: FlowInputs,
  options: FlowStudyOptions
): BroadFlowReport {
  const started = Date.now();
  const spec = FLOW_RULES[args.rule];
  const control = !spec.trial;
  const calendar = options.calendar ?? FLOW_CALENDAR;
  const bootstrapDraws = options.bootstrapDraws ?? FLOW_BOOT_DRAWS;
  assertInCalendar(loaded.inputs, { start: calendar.start, days: calendar.days });
  const inputs = loaded.inputs;
  const plain = broadOptions(loaded.from, loaded.to);
  const base = flowSimOptions(plain, spec.frequency);

  const schedule = flowSchedule(inputs, spec.frequency, base.from, base.to);
  const fv = flowValues(args.rule, inputs, loaded.bars, schedule);
  const asComputed = (subset: TrendSymbolInput[]) => plainValueAt(subset, fv.values);
  const mainSections = sectionsOf(schedule, inputs, plainValueAt(inputs, fv.values));
  const book = rankBook(inputs, schedule, mainSections);
  const main = runTrend(inputs, book.paths, base);
  const first = firstPositionIndex(main);
  const range = { first, last: main.days.length - 1 };
  const tR = slice(main.returns, range);
  const days = slice(main.days, range);
  const boot = (blockLen: number) => ({ blockLen, iterations: bootstrapDraws, seed: FLOW_BOOT_SEED });

  // Gate 2, with the 20 and 120 day blocks reported.
  const sharpe = sharpeCi(tR, boot(FLOW_BLOCK_DAYS));

  // Gate 3: both nulls, the larger p gating.
  const ctx = { inputs, schedule, values: fv.values, opts: base, range, calendar };
  const permuted = flowNull('permuted', ctx, sharpe.point, options.draws, FLOW_NULL_SEED);
  const aligned = flowNull('aligned', ctx, sharpe.point, options.draws, FLOW_NULL_SEED);
  const gatingP = Math.max(permuted.p, aligned.p);

  // Gate 4: drop each listing-year cohort, the legends ten, BTC and ETH, and the top five contributors.
  const contractById = new Map(loaded.contracts.map((c) => [c.id, c]));
  const members = inputs.map((i) => {
    const c = contractById.get(i.symbol);
    if (!c) throw new Error(`${i.symbol}: no contract record`);
    return c;
  });
  const memberDayCount = new Map(inputs.map((i) => [i.symbol, memberDays(i, base)]));
  const totalMemberDays = [...memberDayCount.values()].reduce((s, n) => s + n, 0);
  const drop = (label: string, ids: readonly string[]) => {
    const set = new Set(ids);
    const rest = inputs.filter((i) => !set.has(i.symbol));
    const point = runPoint(runBook(rest, spec.frequency, asComputed, base).run, range);
    const dropped = ids.reduce((s, id) => s + (memberDayCount.get(id) ?? 0), 0);
    return {
      label,
      contracts: [...ids].sort(),
      memberDays: dropped,
      share: totalMemberDays > 0 ? dropped / totalMemberDays : null,
      mean: point.mean,
      sharpe: point.sharpe,
    };
  };
  const cohorts = listingYearCohorts(
    members.map((c) => ({ id: c.id, listingYear: c.listingYear, memberDays: memberDayCount.get(c.id) ?? 0 })),
    COHORT_MIN_SHARE
  );
  const listingYears = cohorts.map((c) => ({ ...drop(c.label, c.contracts), years: c.years }));
  const legendsTen = drop('legends ten', contractsOfAssets(members, LEGENDS_TEN_ASSETS));
  const btcEth = drop('BTC and ETH', contractsOfAssets(members, BTC_ETH_ASSETS));
  const contributions = topContributors(main.contributions, {}, 0, range);
  const top5 = { ...drop('top five', contributions.map((c) => c.contract)), contributions };

  // Gates 5, 6 and 8.
  const years = yearStats(days, tR, FLOW_REPORT_YEARS);
  const stressRun = (haircut?: number) => runBook(inputs, spec.frequency, asComputed, stressOptions(base, haircut)).run;
  const stress = runPoint(stressRun(), range);
  const stressHaircut5 = runPoint(stressRun(STRESS_REPORTED_HAIRCUT), range);
  const afterPaper = windowStats(days, tR, AFTER_PAPER_FROM, AFTER_PAPER_TO);

  // Reported, not gated.
  const paperOverlap = windowStats(days, tR, PAPER_OVERLAP_FROM, PAPER_OVERLAP_TO);
  const delay1 = runPoint(
    runBook(inputs, spec.frequency, (subset) => lagValueAt(subset, fv.values, spec.frequency), base).run,
    range
  );
  const benchmarks = {
    btc: btcBenchmark(loaded, plain, range, tR),
    memberBasket: memberBasketBenchmark(loaded, plain, range, tR),
  };
  const detail = main.broad!;
  const openLong = slice(detail.openLong, range);
  const openShort = slice(detail.openShort, range);
  const exposure = {
    netAtClose: exposureStat(slice(detail.net, range)),
    netAtFill: exposureStat(openLong.map((l, k) => l - openShort[k])),
    grossAtFill: exposureStat(openLong.map((l, k) => l + openShort[k])),
  };
  const perYear = FLOW_REPORT_YEARS.map((year) => {
    const idx: number[] = [];
    for (let k = range.first; k <= range.last; k++) {
      if (main.days[k] >= Date.UTC(year, 0, 1) && main.days[k] < Date.UTC(year + 1, 0, 1)) idx.push(k);
    }
    const pick = (xs: readonly number[]) => idx.map((k) => xs[k]);
    return {
      year,
      days: idx.length,
      mean: finiteOrNull(meanOf(pick(main.returns))),
      annualReturn: finiteOrNull(annualMean(pick(main.returns))),
      longLegAnnual: finiteOrNull(annualMean(pick(main.longLeg))),
      shortLegAnnual: finiteOrNull(annualMean(pick(main.shortLeg))),
      costAnnual: finiteOrNull(annualMean(pick(main.cost))),
      fundingAnnual: finiteOrNull(annualMean(pick(main.funding))),
      turnoverAnnual: finiteOrNull(annualMean(pick(main.turnover))),
      grossMean: finiteOrNull(meanOf(pick(main.gross))),
    };
  });
  const qs = book.periods.map((p) => p.q);
  const periods = {
    count: book.periods.length,
    flat: book.periods.filter((p) => p.q < MIN_QUINTILE).length,
    qMin: finiteOrNull(qs.length > 0 ? Math.min(...qs) : Number.NaN),
    qMedian: finiteOrNull(median(qs)),
    qMax: finiteOrNull(qs.length > 0 ? Math.max(...qs) : Number.NaN),
    membersMedian: finiteOrNull(median(book.periods.map((p) => p.members))),
    rankedMedian: finiteOrNull(median(book.periods.map((p) => p.ranked))),
    unrankedShare: finiteOrNull(unrankedShare(mainSections)),
    list: book.periods,
  };
  const coverage = {
    memberPeriods: book.periods.reduce((s, p) => s + p.members, 0),
    rankedMemberPeriods: book.periods.reduce((s, p) => s + p.ranked, 0),
    unknownBuyDays: Object.fromEntries(
      Object.entries(fv.series)
        .filter(([, s]) => s.unknownDays > 0)
        .map(([id, s]) => [id, s.unknownDays])
    ),
  };
  const orthogonalisation = fv.fits
    ? (() => {
        const fits = fv.fits;
        const at = (p: number) => {
          const f = fits[p];
          return f ? { close: schedule.closes[p], n: f.n, alpha: f.alpha, beta: f.beta } : null;
        };
        const yearEnds = FLOW_REPORT_YEARS.flatMap((year) => {
          let last = -1;
          schedule.closes.forEach((close, p) => {
            if (close < Date.UTC(year + 1, 0, 1) && fits[p]) last = p;
          });
          const fit = last >= 0 ? at(last) : null;
          return fit && new Date(fit.close - DAY_MS).getUTCFullYear() === year ? [fit] : [];
        });
        return {
          periods: fits.length,
          definedPeriods: fits.filter((f) => f !== null).length,
          final: fits.length > 0 ? at(fits.length - 1) : null,
          yearEnds,
        };
      })()
    : null;
  const dayIndex = new Map(main.days.map((d, k) => [d, k]));
  const delistings = detail.delistings.map((d) => ({
    contract: d.symbol,
    day: d.day,
    qty: d.qty,
    close: d.close,
    exitPrice: d.exitPrice,
    haircut: d.haircut,
    fee: d.fee,
    dayContribution: main.contributions[d.symbol][dayIndex.get(d.day)!],
  }));
  const leaves = {
    count: detail.leaves.length,
    traded: detail.leaves.reduce((s, l) => s + l.traded, 0),
    cost: detail.leaves.reduce((s, l) => s + l.cost, 0),
  };
  const carriedDays = Object.fromEntries(members.filter((c) => c.carriedDays > 0).map((c) => [c.id, c.carriedDays]));

  const gates = evaluateFlowGates({
    sampleDays: tR.length,
    sharpeCiLow: sharpe.low,
    permutedP: permuted.p,
    alignedP: aligned.p,
    drops: [...listingYears, legendsTen, btcEth, top5].map((d) => ({ label: d.label, mean: d.mean ?? Number.NaN })),
    yearMeans: years.map((y) => ({ year: y.year, mean: y.mean })),
    stressMean: stress.mean ?? Number.NaN,
    afterPaperMean: afterPaper.mean,
    control,
  });
  const unit = spec.frequency === 'daily' ? 'days' : 'weeks';

  const report: BroadFlowReport = {
    schemaVersion: 3,
    phase: 'broad-flow',
    taskId: args.taskId,
    rule: args.rule,
    role: control ? 'control' : 'trial',
    datasetManifestHash: loaded.datasetHash,
    universe: {
      sha256: loaded.universe.sha256,
      sourceDatasetHash: loaded.universe.sourceDatasetHash,
      startClose: loaded.universe.universe.startClose!,
      startLaterThan20210701: loaded.universe.universe.startLaterThan20210701,
      contracts: inputs.length,
    },
    lockboxApplied: loaded.lockboxApplied,
    parameters: {
      from: base.from,
      to: base.to,
      frequency: spec.frequency,
      orthogonalised: spec.orthogonalised,
      standardiseWindow: STANDARDISE_WINDOW,
      standardiseMinDefined: STANDARDISE_MIN_DEFINED,
      weekMinTradedDays: WEEK_MIN_TRADED_DAYS,
      quintiles: QUINTILES,
      minQuintile: MIN_QUINTILE,
      minFitPairs: MIN_FIT_PAIRS,
      fee: BROAD_FEE.fee,
      slippageTiers: SLIPPAGE_TIERS.map((t) => ({ maxRank: t.maxRank, bps: t.bps })),
      leaveSlippage: LEAVE_SLIPPAGE,
      delistHaircut: DELIST_HAIRCUT,
      stress: {
        feeMultiple: STRESS_FEE_MULTIPLE,
        slippageMultiple: 2,
        delistHaircut: stressBroad(BROAD_COST).delistHaircut,
        reportedHaircut: STRESS_REPORTED_HAIRCUT,
      },
      blockDays: FLOW_BLOCK_DAYS,
      blockSensitivity: [...FLOW_BLOCK_SENSITIVITY],
      bootstrapDraws,
      bootstrapSeed: FLOW_BOOT_SEED,
      nullDraws: options.draws,
      nullSeed: FLOW_NULL_SEED,
      nullCalendarStart: calendar.start,
      nullCalendarDays: calendar.days,
      nullCalendarFirstFriday: calendar.weeks.firstFriday,
      nullCalendarWeeks: calendar.weeks.weeks,
      minShift: spec.frequency === 'daily' ? MIN_SHIFT_DAYS : MIN_SHIFT_WEEKS,
      minSampleDays: FLOW_MIN_SAMPLE_DAYS,
      timingP: FLOW_TIMING_P,
      minPositiveYearShare: FLOW_MIN_POSITIVE_YEAR_SHARE,
      gatedYears: [...FLOW_GATED_YEARS],
      cohortMinShare: COHORT_MIN_SHARE,
      afterPaperFrom: AFTER_PAPER_FROM,
      afterPaperTo: AFTER_PAPER_TO,
      paperOverlapFrom: PAPER_OVERLAP_FROM,
      paperOverlapTo: PAPER_OVERLAP_TO,
    },
    sample: {
      from: base.from,
      to: base.to,
      firstPositionDay: days[0] ?? null,
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
      days: days.length,
    },
    run: summarise(main, range),
    meanDaily: finiteOrNull(meanOf(tR)),
    sharpe: ciJson(sharpe),
    sharpeBlock20: ciJson(sharpeCi(tR, boot(FLOW_BLOCK_SENSITIVITY[0]))),
    sharpeBlock120: ciJson(sharpeCi(tR, boot(FLOW_BLOCK_SENSITIVITY[1]))),
    timing: { permuted: nullJson(permuted, null), aligned: nullJson(aligned, unit), gatingP: finiteOrNull(gatingP) },
    cohorts: { listingYears, legendsTen, btcEth, top5 },
    years: years.map((y) => ({ year: y.year, days: y.days, mean: finiteOrNull(y.mean), sharpe: finiteOrNull(y.sharpe) })),
    stress,
    stressHaircut5,
    afterPaper: {
      from: AFTER_PAPER_FROM,
      to: AFTER_PAPER_TO,
      days: afterPaper.days,
      mean: finiteOrNull(afterPaper.mean),
      sharpe: finiteOrNull(afterPaper.sharpe),
    },
    paperOverlap: {
      from: PAPER_OVERLAP_FROM,
      to: PAPER_OVERLAP_TO,
      days: paperOverlap.days,
      mean: finiteOrNull(paperOverlap.mean),
      sharpe: finiteOrNull(paperOverlap.sharpe),
    },
    delay1,
    benchmarks,
    exposure,
    perYear,
    periods,
    coverage,
    orthogonalisation,
    delistings,
    leaves,
    funding: loaded.funding,
    fundingResolutions: loaded.fundingResolutions,
    carriedDays,
    gates,
    verdict: flowVerdict(gates, control),
    daily: { days, returns: tR },
    computedAt: new Date().toISOString(),
    gitCommit: options.gitCommit ?? 'unknown',
    durationMs: Date.now() - started,
  };

  const validated = validateBroadFlowReport(report);
  if (!validated.ok) throw new Error(`Broad flow report failed its schema: ${validated.issues.join('; ')}`);
  return validated.data;
}

const pct = (v: number | null, digits = 2) => (v === null ? '-' : `${(v * 100).toFixed(digits)}%`);
const num = (v: number | null, digits = 2) => (v === null ? '-' : v.toFixed(digits));

export function formatFlow(r: BroadFlowReport): string {
  const lines: string[] = [];
  lines.push(
    `${r.rule} (${r.role}, ${r.parameters.frequency}${r.parameters.orthogonalised ? ', orthogonalised' : ''}): ${r.universe.contracts} member contracts, ` +
      `${r.sample.firstDay === null ? '-' : isoDay(r.sample.firstDay)} to ${r.sample.lastDay === null ? '-' : isoDay(r.sample.lastDay)} ` +
      `(${r.sample.days} days), lockbox ${r.lockboxApplied}, export ${r.datasetManifestHash.slice(0, 12)}, universe ${r.universe.sha256.slice(0, 12)}`
  );
  lines.push(
    `book Sharpe ${num(r.sharpe.point)} CI [${num(r.sharpe.low)}, ${num(r.sharpe.high)}]  mean ${pct(r.meanDaily, 3)}/day annual ${pct(r.run.annualReturn)}  ` +
      `long ${pct(r.run.longLegAnnual)} short ${pct(r.run.shortLegAnnual)} cost ${pct(r.run.costAnnual)} funding ${pct(r.run.fundingAnnual)}  ` +
      `maxDD ${pct(r.run.maxDrawdown, 1)} turnover ${num(r.run.turnoverAnnual, 1)}x gross ${num(r.run.gross.mean)}`
  );
  lines.push(
    `net at close mean ${num(r.exposure.netAtClose.mean, 4)} (|max| ${num(r.exposure.netAtClose.maxAbs, 4)}), at fill |max| ${num(r.exposure.netAtFill.maxAbs, 6)}; ` +
      `periods ${r.periods.count} (flat ${r.periods.flat}), q ${num(r.periods.qMin, 0)}-${num(r.periods.qMax, 0)} median ${num(r.periods.qMedian, 0)}, unranked ${pct(r.periods.unrankedShare, 1)}`
  );
  lines.push(
    `vs BTC alpha ${pct(r.benchmarks.btc.alpha)} (beta ${num(r.benchmarks.btc.beta)}); vs members alpha ${pct(r.benchmarks.memberBasket.alpha)} (beta ${num(r.benchmarks.memberBasket.beta)})`
  );
  lines.push(
    `timing permuted p ${num(r.timing.permuted.p, 3)}, aligned p ${num(r.timing.aligned.p, 3)} (outside life ${num(r.timing.aligned.outsideLifeShare, 3)}, ` +
      `unranked ${num(r.timing.aligned.unrankedShare, 3)})`
  );
  const drops = [...r.cohorts.listingYears, r.cohorts.legendsTen, r.cohorts.btcEth, r.cohorts.top5];
  lines.push(`drops ${drops.map((d) => `${d.label} ${pct(d.mean, 3)}`).join(', ')}`);
  lines.push(`years ${r.years.map((y) => `${y.year} ${pct(y.mean, 3)}`).join(', ')}`);
  lines.push(
    `stress ${pct(r.stress.mean, 3)} (5% haircut ${pct(r.stressHaircut5.mean, 3)}); after paper ${pct(r.afterPaper.mean, 3)}; ` +
      `paper overlap ${pct(r.paperOverlap.mean, 3)} Sharpe ${num(r.paperOverlap.sharpe)}; delay 1 Sharpe ${num(r.delay1.sharpe)}; ` +
      `delistings ${r.delistings.length}, leaves ${r.leaves.count}`
  );
  lines.push(`gates ${r.gates.map((g) => `${g.id} ${g.name} ${g.pass === null ? (r.role === 'control' ? 'n/a' : 'PENDING') : g.pass ? 'pass' : 'FAIL'}`).join(', ')}`);
  lines.push(`VERDICT ${r.verdict}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await loadFlowInputs(args.datasetDir, args.universeFile, {
    fundingResolutionsPath: args.fundingResolutions,
    fundingCheckOut: args.fundingCheckOut,
  });
  const report = runBroadFlowStudy(args, loaded, { draws: args.draws, gitCommit: resolveCommit() });
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(formatFlow(report));
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
