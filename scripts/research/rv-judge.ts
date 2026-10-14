/**
 * The judge of the rv-v1 re-validation (header VERDICT, REPORTED and CALIBRATION ACCEPTANCE in
 * scripts/research/rv-revalidation.ts). The 7C runner calls it in a container:
 *
 *   rv-judge.ts jobs is-mcpt|wf-mcpt|block|calibrate
 *   rv-judge.ts merge --stage S --dir D --inputs-dir O --expect-manifest-hash H --out S.json
 *   rv-judge.ts dsr --real real.json --inputs-dir O --expect-manifest-hash H
 *   rv-judge.ts verdict --real real.json --is is-mcpt.json --wf wf-mcpt.json --block block.json
 *                       --inputs-dir O --expect-manifest-hash H --out verdict.json
 *   rv-judge.ts check-calibration --dir D --out calibration.json     (exit 2 when an acceptance rule fails)
 *
 * Every mode but `jobs` and `check-calibration` loads the recorded panel through loadInputs, which recomputes its
 * sha256 and refuses on any mismatch with the record, the expected manifest hash or GIT_COMMIT, and then requires
 * every file it reads to carry that same provenance. check-calibration reads no real data and requires every
 * calibration output to carry GIT_COMMIT.
 */
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

import { deflatedSharpe } from '@/lib/stats/deflated-sharpe';
import { sampleKurtosis, sampleSkewness } from '@/lib/stats/normal';
import { gate8Variance, type Gate8Variance } from './legends-dsr';
import {
  CALIBRATION_BARS,
  CALIBRATION_UNIVERSES,
  RV_CELLS,
  RV_SEEDS,
  RV_V1_CELL_INDEX,
  RV_WF_GEOMETRY,
  annualise,
  assertDistinctSeeds,
  objective,
  pValue,
  type StepDetail,
  type UniverseKind,
} from './rv-mcpt';
import {
  FUNDING_MARK_NOTE,
  calibrationJobs,
  gitCommitFromEnv,
  loadInputs,
  shardJobs,
  stageSeed,
  type CalibrationOutput,
  type Provenance,
  type RealOutput,
  type ShardStage,
} from './rv-stages';

/** Header VERDICT: G1 and G2 at p < 0.01, G3 at a deflated Sharpe probability of at least 0.95 at N = 672. */
export const G12_THRESHOLD = 0.01;
export const DSR_MIN = 0.95;
export const DSR_GATE_TRIALS = 672;
/** Header REPORTED: N = 26 (14 recorded configurations plus 12) and the program count 2,161. */
export const DSR_REPORTED_TRIALS = [26, 2161] as const;
/** Header STEPS 2 and 4, REPORTED: M per stage. */
const STAGE_M: Record<ShardStage, number> = { 'is-mcpt': 1000, 'wf-mcpt': 1000, block: 1000 };

const SLICE_FROM = Date.UTC(2026, 6, 1);
const BARS_PER_YEAR = 365.25 * 3;

// ------------------------------------------------------------------------------------------------ KS

/** Matrix product of two m x m row-major matrices. */
function matMul(a: Float64Array, b: Float64Array, m: number): Float64Array {
  const c = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < m; k++) {
      const aik = a[i * m + k];
      if (aik === 0) continue;
      for (let j = 0; j < m; j++) c[i * m + j] += aik * b[k * m + j];
    }
  }
  return c;
}

/** A^n with a decimal exponent kept aside so the entries stay in range (Marsaglia, Tsang and Wang 2003). */
function matPow(a: Float64Array, m: number, n: number): { v: Float64Array; e: number } {
  if (n === 1) return { v: Float64Array.from(a), e: 0 };
  const half = matPow(a, m, Math.floor(n / 2));
  let v = matMul(half.v, half.v, m);
  let e = 2 * half.e;
  if (n % 2 === 1) v = matMul(a, v, m);
  const mid = Math.floor(m / 2);
  if (v[mid * m + mid] > 1e140) {
    for (let i = 0; i < v.length; i++) v[i] *= 1e-140;
    e += 140;
  }
  return { v, e };
}

/**
 * P(D_n < d) for the one-sample Kolmogorov-Smirnov statistic of n uniforms, exact, by the method of Marsaglia,
 * Tsang and Wang (2003), "Evaluating Kolmogorov's Distribution", without its right-tail shortcut.
 */
export function kolmogorovCdf(n: number, d: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error(`n must be a positive integer, got ${n}`);
  if (d <= 0) return 0;
  if (d >= 1) return 1;
  const k = Math.floor(n * d) + 1;
  const m = 2 * k - 1;
  const h = k - n * d;
  const H = new Float64Array(m * m);
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) H[i * m + j] = i - j + 1 < 0 ? 0 : 1;
  for (let i = 0; i < m; i++) {
    H[i * m] -= h ** (i + 1);
    H[(m - 1) * m + i] -= h ** (m - i);
  }
  H[(m - 1) * m] += 2 * h - 1 > 0 ? (2 * h - 1) ** m : 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      if (i - j + 1 > 0) for (let g = 1; g <= i - j + 1; g++) H[i * m + j] /= g;
    }
  }
  const { v, e } = matPow(H, m, n);
  let s = v[(k - 1) * m + k - 1];
  let eQ = e;
  for (let i = 1; i <= n; i++) {
    s = (s * i) / n;
    if (s < 1e-140) {
      s *= 1e140;
      eQ -= 140;
    }
  }
  return s * 10 ** eQ;
}

/**
 * The Kolmogorov-Smirnov test of a sample against the continuous uniform on [0, 1]: D = sup |F_n(x) - x| and
 * p = P(D_n >= D). Permutation p-values are discrete on a 1 / (M + 1) grid, which can only raise D by up to that
 * step, so the test is at most stricter than for continuous p-values.
 */
export function ksUniform(sample: readonly number[]): { n: number; d: number; p: number } {
  if (sample.length === 0) throw new Error('the KS sample is empty');
  if (sample.some((x) => !(x >= 0 && x <= 1))) throw new Error('every KS value must lie in [0, 1]');
  const xs = [...sample].sort((a, b) => a - b);
  const n = xs.length;
  let d = 0;
  for (let i = 0; i < n; i++) d = Math.max(d, (i + 1) / n - xs[i], xs[i] - i / n);
  return { n, d, p: Math.min(1, Math.max(0, 1 - kolmogorovCdf(n, d))) };
}

// ------------------------------------------------------------------------------------------------ DSR

export interface DsrAt {
  N: number;
  benchmark: number;
  probability: number;
}

export interface RvDsr {
  observedSharpe: number;
  T: number;
  skewness: number;
  kurtosis: number;
  sharpes: number[];
  variance: Gate8Variance;
  gate: DsrAt & { pass: boolean };
  reported: DsrAt[];
}

/**
 * Header VERDICT G3: the deflated Sharpe probability of cell 11's full-span per-bar net taker series at N = 672,
 * with V = max(sample variance of the 12 cells' per-bar Sharpes, 1 / (T - 1)) (the floor of broad-dsr.ts through
 * legends-dsr.ts gate8Variance), T the length of cell 11's series, and that series' skewness and raw kurtosis.
 * N = 26 and 2,161 are reported only.
 */
export function rvDsr(cellReturns: readonly (readonly number[])[]): RvDsr {
  if (cellReturns.length !== RV_CELLS.length) throw new Error(`rvDsr needs the 12 cells' series, got ${cellReturns.length}`);
  const series = cellReturns[RV_V1_CELL_INDEX] as number[];
  const sharpes = cellReturns.map((r) => objective(r));
  const T = series.length;
  const variance = gate8Variance(sharpes, 'max-cross-sampling', T);
  const skewness = sampleSkewness(series);
  const kurtosis = sampleKurtosis(series);
  const at = (N: number): DsrAt => {
    const d = deflatedSharpe({ observedSharpe: sharpes[RV_V1_CELL_INDEX], numTrials: N, varianceOfTrialSharpes: variance.used, nObservations: T, skewness, kurtosis });
    return { N, benchmark: d.benchmarkSharpe, probability: d.probability };
  };
  const gate = at(DSR_GATE_TRIALS);
  return {
    observedSharpe: sharpes[RV_V1_CELL_INDEX],
    T,
    skewness,
    kurtosis,
    sharpes,
    variance,
    gate: { ...gate, pass: gate.probability >= DSR_MIN },
    reported: DSR_REPORTED_TRIALS.map(at),
  };
}

// ------------------------------------------------------------------------------------------------ merge

export interface MergedNull {
  stage: ShardStage;
  M: number;
  provenance: Provenance;
  /** The null statistic of permutation m at index m - 1. */
  nulls: number[];
}

const sameProvenance = (a: Provenance, b: Provenance) => a.manifestHash === b.manifestHash && a.panelSha256 === b.panelSha256 && a.gitCommit === b.gitCommit;

const HeaderSchema = z.object({
  kind: z.literal('header'),
  stage: z.enum(['is-mcpt', 'wf-mcpt', 'block']),
  name: z.string(),
  mFrom: z.number().int(),
  mTo: z.number().int(),
  M: z.number().int(),
  provenance: z.object({ manifestHash: z.string(), panelSha256: z.string(), gitCommit: z.string() }),
});
const LineSchema = z.object({
  m: z.number().int(),
  seed: z.number().int(),
  best: z.number().nullable(),
  perCell: z.array(z.number()).optional(),
  cells: z.array(z.number().int()).optional(),
});

/**
 * Judge `merge`: the shard files of a stage must be exactly the jobs of shardJobs(stage), each with its own header
 * (stage, name, range, the stage's M and the expected provenance), and together hold each m = 1..M exactly once,
 * with the header's seed for m and a finite statistic. The seeds are asserted distinct after the >>> 0 reduction.
 */
export function mergeShards(stage: ShardStage, files: readonly { name: string; text: string }[], expect: Provenance): MergedNull {
  const jobs = shardJobs(stage);
  const M = STAGE_M[stage];
  const byName = new Map(files.map((f) => [f.name, f]));
  if (byName.size !== files.length) throw new Error(`duplicate shard file names in ${stage}`);
  const expected = new Set(jobs.map((j) => `${j.name}.jsonl`));
  const stray = files.filter((f) => !expected.has(f.name)).map((f) => f.name);
  if (stray.length > 0) throw new Error(`files that are not ${stage} shards: ${stray.join(', ')}`);
  const missing = jobs.filter((j) => !byName.has(`${j.name}.jsonl`)).map((j) => j.name);
  if (missing.length > 0) throw new Error(`missing shards of ${stage}: ${missing.join(', ')}`);

  const seedOf = stageSeed(stage);
  const nulls: (number | undefined)[] = Array(M).fill(undefined);
  for (const job of jobs) {
    const rows = byName
      .get(`${job.name}.jsonl`)!
      .text.split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as unknown);
    const header = HeaderSchema.parse(rows[0]);
    if (header.stage !== stage || header.name !== job.name || header.mFrom !== job.mFrom || header.mTo !== job.mTo) {
      throw new Error(`${job.name}: its header names ${header.stage} ${header.name} ${header.mFrom}..${header.mTo}, expected ${stage} ${job.name} ${job.mFrom}..${job.mTo}`);
    }
    if (header.M !== M) throw new Error(`${job.name}: M ${header.M} is not the asserted M = ${M}`);
    if (!sameProvenance(header.provenance, expect)) throw new Error(`${job.name}: provenance ${JSON.stringify(header.provenance)} is not the inputs' ${JSON.stringify(expect)}`);
    for (const raw of rows.slice(1)) {
      const line = LineSchema.parse(raw);
      if (line.m < job.mFrom || line.m > job.mTo) throw new Error(`${job.name}: m = ${line.m} lies outside ${job.mFrom}..${job.mTo}`);
      if (nulls[line.m - 1] !== undefined) throw new Error(`${job.name}: duplicate m = ${line.m}`);
      if (line.seed !== seedOf(line.m)) throw new Error(`${job.name}: m = ${line.m} used seed ${line.seed}, the header's seed is ${seedOf(line.m)}`);
      if (line.best === null || !Number.isFinite(line.best)) throw new Error(`${job.name}: the statistic of m = ${line.m} is not finite`);
      nulls[line.m - 1] = line.best;
    }
  }
  const absent = nulls.map((x, i) => (x === undefined ? i + 1 : null)).filter((x): x is number => x !== null);
  if (absent.length > 0) throw new Error(`${stage}: no line for m = ${absent.slice(0, 10).join(', ')}${absent.length > 10 ? ', ...' : ''}`);
  assertDistinctSeeds({ [stage]: Array.from({ length: M }, (_, i) => seedOf(i + 1)) });
  return { stage, M, provenance: expect, nulls: nulls as number[] };
}

// ------------------------------------------------------------------------------------------------ reported statistics

export interface PeriodStats {
  n: number;
  total: number;
  annualised: number;
}

export interface SeriesStats extends PeriodStats {
  perBar: number;
  maxDrawdown: number;
  profitFactor: number | null;
  grossAnnualised: number | null;
  grossTotal: number | null;
  /** Sums of the per-bar components (arithmetic, in return units). */
  funding: number | null;
  price: number | null;
  cost: number | null;
  /** Funding over the sum of net returns, the prediction's "funding share of net PnL". */
  fundingShare: number | null;
  annualTurnover: number | null;
  perYear: (PeriodStats & { year: number })[];
  since20260701: PeriodStats;
}

const compound = (rs: readonly number[]) => rs.reduce((e, r) => e * (1 + r), 1) - 1;
const periodOf = (rs: number[]): PeriodStats => ({ n: rs.length, total: compound(rs), annualised: annualise(objective(rs)) });
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Header REPORTED figures of one per-bar series whose return i starts at t[firstStep + i]: Sharpe, compounded
 * return, max drawdown of the compounded curve, profit factor (sum of gains over sum of losses), gross of costs,
 * the funding, price and cost sums with the funding share, annual turnover, per calendar year (UTC) and the slice
 * from 2026-07-01.
 */
export function seriesStats(returns: readonly number[], t: readonly number[], firstStep: number, detail: StepDetail | null): SeriesStats {
  const rs = [...returns];
  const starts = rs.map((_, i) => t[firstStep + i]);
  if (starts.some((x) => x === undefined)) throw new Error('the series runs past the bar times');
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const r of rs) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - equity / peak);
  }
  const gains = sum(rs.filter((r) => r > 0));
  const losses = -sum(rs.filter((r) => r < 0));
  const years = [...new Set(starts.map((s) => new Date(s).getUTCFullYear()))].sort();
  const gross = detail ? rs.map((r, i) => r + detail.cost[i]) : null;
  const funding = detail ? sum(detail.funding) : null;
  return {
    ...periodOf(rs),
    perBar: objective(rs),
    maxDrawdown,
    profitFactor: losses > 0 ? gains / losses : null,
    grossAnnualised: gross ? annualise(objective(gross)) : null,
    grossTotal: gross ? compound(gross) : null,
    funding,
    price: detail ? sum(detail.price) : null,
    cost: detail ? sum(detail.cost) : null,
    fundingShare: funding !== null && sum(rs) !== 0 ? funding / sum(rs) : null,
    annualTurnover: detail ? (sum(detail.turnover) / rs.length) * BARS_PER_YEAR : null,
    perYear: years.map((year) => ({ year, ...periodOf(rs.filter((_, i) => new Date(starts[i]).getUTCFullYear() === year)) })),
    since20260701: periodOf(rs.filter((_, i) => starts[i] >= SLICE_FROM)),
  };
}

// ------------------------------------------------------------------------------------------------ verdict

export interface Gate12 {
  p: number;
  threshold: number;
  pass: boolean;
}

export interface Verdict {
  provenance: Provenance;
  pass: boolean;
  gates: { G1: Gate12; G2: Gate12; G3: { probability: number; threshold: number; N: number; pass: boolean } };
  step1: { best: number; bestCell: number; bestAnnualised: number };
  step3: { objective: number; annualised: number };
  dsr: RvDsr;
  reported: {
    rvV1: SeriesStats;
    walkForward: SeriesStats;
    maker: SeriesStats & { makerFills: number; fallbackFills: number };
    stress: { costs: RealOutput['stress']['costs']; perBar: number; annualised: number };
    neighbours: { cell: number; buffer: number; betaNeutral: boolean; flowOn: boolean; perBar: number; annualised: number }[];
    folds: { f: number; testFrom: number; testTo: number; cell: number }[];
    distinctFoldCells: number;
    blockP: number;
    dsrReported: DsrAt[];
    purge: { objective: number; annualised: number; cells: number[] };
    deskFillQuality: string;
    predictions: { g3Fails: boolean; fundingShareAbove50: boolean | null; step2Passes: boolean; foldsSelectDifferentCells: boolean };
  };
  notes: string[];
}

const DESK_NOTE =
  'Desk fill quality by rebalance hour (00, 08, 16 UTC) and weekday or weekend is recorded by the forward desk and reported with the desk read, never part of this study.';

/**
 * Judge `verdict` (header VERDICT): G1 = step 2 p < 0.01 on the best of the 12 cells, G2 = step 4 p < 0.01 on the
 * stitched walk-forward objective, G3 = deflated Sharpe of cell 11 at N = 672 >= 0.95. All three must pass. Every
 * statistic is recomputed from the real file's series and must equal what it records. Then every REPORTED item the
 * inputs allow.
 */
export function judgeVerdict(real: RealOutput, merged: { is: MergedNull; wf: MergedNull; block: MergedNull }, expect: Provenance): Verdict {
  if (!sameProvenance(real.provenance, expect)) throw new Error(`the real file's provenance ${JSON.stringify(real.provenance)} is not the inputs' ${JSON.stringify(expect)}`);
  for (const [stage, m] of [
    ['is-mcpt', merged.is],
    ['wf-mcpt', merged.wf],
    ['block', merged.block],
  ] as const) {
    if (m.stage !== stage) throw new Error(`expected the ${stage} null, got ${m.stage}`);
    if (!sameProvenance(m.provenance, expect)) throw new Error(`the ${stage} null's provenance is not the inputs'`);
    if (m.M !== STAGE_M[stage] || m.nulls.length !== STAGE_M[stage]) throw new Error(`the ${stage} null holds ${m.nulls.length} values, M = ${STAGE_M[stage]} asserted`);
  }
  const objectives = real.step1.returns.map((r) => objective(r));
  if (objectives.length !== 12 || objectives.some((o, i) => o !== real.step1.objectives[i])) throw new Error('the real file\'s step 1 objectives do not recompute from its series');
  const best = Math.max(...objectives);
  if (best !== real.step1.best) throw new Error('the real file\'s best objective does not recompute');
  const wfObjective = objective(real.step3.returns);
  if (wfObjective !== real.step3.objective) throw new Error('the real file\'s walk-forward objective does not recompute');
  if (real.rvV1.returns.some((r, i) => r !== real.step1.returns[RV_V1_CELL_INDEX][i])) throw new Error('the rv-v1 series is not cell 11\'s');

  const g1 = pValue(best, merged.is.nulls);
  const g2 = pValue(wfObjective, merged.wf.nulls);
  const dsr = rvDsr(real.step1.returns);
  const gates = {
    G1: { p: g1, threshold: G12_THRESHOLD, pass: g1 < G12_THRESHOLD },
    G2: { p: g2, threshold: G12_THRESHOLD, pass: g2 < G12_THRESHOLD },
    G3: { probability: dsr.gate.probability, threshold: DSR_MIN, N: DSR_GATE_TRIALS, pass: dsr.gate.pass },
  };
  const rvV1 = seriesStats(real.rvV1.returns, real.t, real.firstStep, real.rvV1.detail);
  const folds = real.step3.folds.map((f) => ({ f: f.f, testFrom: f.testFrom, testTo: f.testTo, cell: f.cell }));
  return {
    provenance: expect,
    pass: gates.G1.pass && gates.G2.pass && gates.G3.pass,
    gates,
    step1: { best, bestCell: objectives.indexOf(best), bestAnnualised: annualise(best) },
    step3: { objective: wfObjective, annualised: annualise(wfObjective) },
    dsr,
    reported: {
      rvV1,
      walkForward: seriesStats(real.step3.returns, real.t, real.step3.firstStep, real.step3.detail),
      maker: {
        ...seriesStats(real.maker.returns, real.t, real.firstStep, real.maker.detail),
        makerFills: real.maker.detail.makerFills ?? 0,
        fallbackFills: real.maker.detail.fallbackFills ?? 0,
      },
      stress: { costs: real.stress.costs, perBar: objective(real.stress.returns), annualised: annualise(objective(real.stress.returns)) },
      neighbours: RV_CELLS.map((c) => ({ cell: c.index, buffer: c.buffer, betaNeutral: c.betaNeutral, flowOn: c.flowOn, perBar: objectives[c.index], annualised: annualise(objectives[c.index]) })),
      folds,
      distinctFoldCells: new Set(folds.map((f) => f.cell)).size,
      blockP: pValue(best, merged.block.nulls),
      dsrReported: dsr.reported,
      purge: { objective: real.purge.objective, annualised: annualise(real.purge.objective), cells: real.purge.folds.map((f) => f.cell) },
      deskFillQuality: DESK_NOTE,
      predictions: {
        g3Fails: !gates.G3.pass,
        fundingShareAbove50: rvV1.fundingShare === null ? null : rvV1.fundingShare > 0.5,
        step2Passes: gates.G1.pass,
        foldsSelectDifferentCells: new Set(folds.map((f) => f.cell)).size > 1,
      },
    },
    notes: [real.fundingMarkNote, FUNDING_MARK_NOTE, DESK_NOTE].filter((x, i, all) => all.indexOf(x) === i),
  };
}

// ------------------------------------------------------------------------------------------------ calibration acceptance

export interface StepAcceptance {
  ps: number[];
  ks: { n: number; d: number; p: number };
  share05: number;
  pass: boolean;
}

export interface CalibrationCheck {
  universes: { kind: UniverseKind; k: number; seed: number; isP: number; wfP: number }[];
  iid: { is: StepAcceptance; wf: StepAcceptance; pass: boolean };
  planted: { isPs: number[]; wfPs: number[]; isAt01: number; wfAt01: number; pass: boolean };
  garch: { is: StepAcceptance; wf: StepAcceptance };
  carry: { isPs: number[]; wfPs: number[]; isAt01: number; wfAt01: number };
  timing: CalibrationOutput['timing'];
  pass: boolean;
}

/** Header: a driftless step passes when KS p > 0.01 and the share of p <= 0.05 is at most 0.11. */
function driftless(ps: number[]): StepAcceptance {
  const ks = ksUniform(ps);
  const share05 = ps.filter((p) => p <= 0.05).length / ps.length;
  return { ps, ks, share05, pass: ks.p > 0.01 && share05 <= 0.11 };
}

/**
 * Judge `check-calibration` (header CALIBRATION ACCEPTANCE): the outputs must be exactly calibrationJobs(), each at
 * the header scale (3,000 bars, the header geometry, its universe's M) with its universe seed, inner seeds
 * s * 10,000 + m for m = 1..M, and GIT_COMMIT. iid passes when both steps pass the driftless rule over the 100
 * seeds. planted passes when at least 9 of 10 seeds have step 2 p <= 0.01 and at least 8 of 10 step 4 p <= 0.01.
 * GARCH and carry-only are reported. Also the mean wall times (addendum rule 11).
 */
export function checkCalibration(outputs: readonly CalibrationOutput[], gitCommit: string): CalibrationCheck {
  const jobs = calibrationJobs();
  const key = (kind: string, k: number) => `${kind}|${k}`;
  const byKey = new Map<string, CalibrationOutput>();
  for (const o of outputs) {
    if (byKey.has(key(o.kind, o.k))) throw new Error(`duplicate calibration output ${o.kind} ${o.k}`);
    byKey.set(key(o.kind, o.k), o);
  }
  const missing = jobs.filter((j) => !byKey.has(key(j.kind, j.k))).map((j) => j.name);
  if (missing.length > 0) throw new Error(`missing calibration outputs: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', ...' : ''}`);
  if (byKey.size !== jobs.length) throw new Error(`${byKey.size} calibration outputs, ${jobs.length} expected`);

  const universes: CalibrationCheck['universes'] = [];
  for (const job of jobs) {
    const o = byKey.get(key(job.kind, job.k))!;
    const spec = CALIBRATION_UNIVERSES[job.kind];
    const label = job.name;
    if (o.gitCommit !== gitCommit) throw new Error(`${label} ran at commit ${o.gitCommit}, the check runs at ${gitCommit}`);
    if (o.seed !== spec.seed(job.k)) throw new Error(`${label} used universe seed ${o.seed}, the header's is ${spec.seed(job.k)}`);
    if (o.bars !== CALIBRATION_BARS) throw new Error(`${label} has ${o.bars} bars, the header's synthetic panels have ${CALIBRATION_BARS}`);
    if (o.geometry.train !== RV_WF_GEOMETRY.train || o.geometry.test !== RV_WF_GEOMETRY.test) throw new Error(`${label} ran another walk-forward geometry`);
    if (o.M !== spec.M) throw new Error(`${label} ran M ${o.M}, the header's M for ${job.kind} is ${spec.M}`);
    const ps: Record<'is' | 'wf', number> = { is: 0, wf: 0 };
    for (const step of ['is', 'wf'] as const) {
      const nulls = o[step].nulls;
      if (nulls.length !== spec.M) throw new Error(`${label} step ${step} holds ${nulls.length} permutations, M ${spec.M}`);
      nulls.forEach((l, i) => {
        if (l.m !== i + 1) throw new Error(`${label} step ${step} line ${i + 1} is m = ${l.m}`);
        if (l.seed !== RV_SEEDS.inner(o.seed, l.m)) throw new Error(`${label} step ${step} m = ${l.m} used seed ${l.seed}, the header's is ${RV_SEEDS.inner(o.seed, l.m)}`);
      });
      ps[step] = pValue(o[step].real, nulls.map((l) => l.best));
    }
    universes.push({ kind: job.kind, k: job.k, seed: o.seed, isP: ps.is, wfP: ps.wf });
  }

  const of = (kind: UniverseKind, step: 'isP' | 'wfP') => universes.filter((u) => u.kind === kind).map((u) => u[step]);
  const at01 = (ps: number[]) => ps.filter((p) => p <= 0.01).length;
  const iidIs = driftless(of('iid', 'isP'));
  const iidWf = driftless(of('iid', 'wfP'));
  const planted = { isPs: of('planted', 'isP'), wfPs: of('planted', 'wfP'), isAt01: at01(of('planted', 'isP')), wfAt01: at01(of('planted', 'wfP')) };
  const plantedPass = planted.isAt01 >= 9 && planted.wfAt01 >= 8;
  const mean = (f: (o: CalibrationOutput) => number) => outputs.reduce((a, o) => a + f(o), 0) / outputs.length;
  const timing = {
    prepareMs: mean((o) => o.timing.prepareMs),
    oneCellMs: mean((o) => o.timing.oneCellMs),
    twelveCellsMs: mean((o) => o.timing.twelveCellsMs),
    isPermutationMs: mean((o) => o.timing.isPermutationMs),
    wfPermutationMs: mean((o) => o.timing.wfPermutationMs),
  };
  const iidPass = iidIs.pass && iidWf.pass;
  return {
    universes,
    iid: { is: iidIs, wf: iidWf, pass: iidPass },
    planted: { ...planted, pass: plantedPass },
    garch: { is: driftless(of('garch', 'isP')), wf: driftless(of('garch', 'wfP')) },
    carry: { isPs: of('carry', 'isP'), wfPs: of('carry', 'wfP'), isAt01: at01(of('carry', 'isP')), wfAt01: at01(of('carry', 'wfP')) },
    timing,
    pass: iidPass && plantedPass,
  };
}

// ------------------------------------------------------------------------------------------------ jobs

/** Judge `jobs`: the runner's job list, one line per job. */
export function jobLines(stage: ShardStage | 'calibrate'): string[] {
  if (stage === 'calibrate') return calibrationJobs().map((j) => `${j.name} ${j.kind} ${j.k}`);
  if (!(stage in STAGE_M)) throw new Error(`unknown stage ${stage}: is-mcpt, wf-mcpt, block or calibrate`);
  return shardJobs(stage).map((j) => `${j.name} ${j.stage} ${j.mFrom} ${j.mTo}`);
}

// ------------------------------------------------------------------------------------------------ CLI

function flags(argv: string[], allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith('--') || !allowed.includes(key.slice(2))) throw new Error(`unknown flag ${key}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    out[key.slice(2)] = value;
  }
  for (const a of allowed) if (out[a] === undefined) throw new Error(`--${a} is required`);
  return out;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(4) : String(x));

function main(): void {
  try {
    const [mode, ...rest] = process.argv.slice(2);
    if (mode === 'jobs') {
      if (rest.length !== 1) throw new Error('usage: rv-judge.ts jobs is-mcpt|wf-mcpt|block|calibrate');
      for (const line of jobLines(rest[0] as ShardStage | 'calibrate')) console.log(line);
      process.exit(0);
    }
    const gitCommit = gitCommitFromEnv();
    if (mode === 'merge') {
      const a = flags(rest, ['stage', 'dir', 'inputs-dir', 'expect-manifest-hash', 'out']);
      const stage = a.stage as ShardStage;
      if (!(stage in STAGE_M)) throw new Error(`--stage must be is-mcpt, wf-mcpt or block`);
      const { provenance } = loadInputs(a['inputs-dir'], { manifestHash: a['expect-manifest-hash'], gitCommit });
      const files = readdirSync(a.dir).map((name) => ({ name, text: readFileSync(join(a.dir, name), 'utf8') }));
      const merged = mergeShards(stage, files, provenance);
      writeFileSync(a.out, JSON.stringify(merged));
      console.log(`merge ${stage}: M = ${merged.M} from ${files.length} shards`);
    } else if (mode === 'dsr') {
      const a = flags(rest, ['real', 'inputs-dir', 'expect-manifest-hash']);
      const { provenance } = loadInputs(a['inputs-dir'], { manifestHash: a['expect-manifest-hash'], gitCommit });
      const real = readJson<RealOutput>(a.real);
      if (!sameProvenance(real.provenance, provenance)) throw new Error('the real file\'s provenance is not the inputs\'');
      const d = rvDsr(real.step1.returns);
      console.log(JSON.stringify(d));
      console.log(
        `G3: DSR ${fmt(d.gate.probability)} at N = ${d.gate.N} (${d.gate.pass ? 'pass' : 'fail'}), SR ${fmt(annualise(d.observedSharpe))} annualised, ` +
          `benchmark ${fmt(annualise(d.gate.benchmark))}, V ${d.variance.used.toExponential(3)} (${d.variance.used === d.variance.floor ? 'floor' : 'cross-cell'}), T ${d.T}; ` +
          d.reported.map((r) => `N = ${r.N}: ${fmt(r.probability)}`).join(', ')
      );
    } else if (mode === 'verdict') {
      const a = flags(rest, ['real', 'is', 'wf', 'block', 'inputs-dir', 'expect-manifest-hash', 'out']);
      const { provenance } = loadInputs(a['inputs-dir'], { manifestHash: a['expect-manifest-hash'], gitCommit });
      const v = judgeVerdict(readJson<RealOutput>(a.real), { is: readJson<MergedNull>(a.is), wf: readJson<MergedNull>(a.wf), block: readJson<MergedNull>(a.block) }, provenance);
      writeFileSync(a.out, JSON.stringify(v, null, 2));
      const g = v.gates;
      console.log(`G1 step 2 p ${fmt(g.G1.p)} ${g.G1.pass ? 'PASS' : 'FAIL'}`);
      console.log(`G2 step 4 p ${fmt(g.G2.p)} ${g.G2.pass ? 'PASS' : 'FAIL'}`);
      console.log(`G3 DSR ${fmt(g.G3.probability)} at N = ${g.G3.N} ${g.G3.pass ? 'PASS' : 'FAIL'}`);
      console.log(`VERDICT ${v.pass ? 'PASS' : 'FAIL'}`);
      for (const note of v.notes) console.log(note);
    } else if (mode === 'check-calibration') {
      const a = flags(rest, ['dir', 'out']);
      const outputs = readdirSync(a.dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => readJson<CalibrationOutput>(join(a.dir, n)));
      const c = checkCalibration(outputs, gitCommit);
      writeFileSync(a.out, JSON.stringify(c, null, 2));
      console.log(`iid step 2: KS p ${fmt(c.iid.is.ks.p)}, share p <= 0.05 ${fmt(c.iid.is.share05)}; step 4: KS p ${fmt(c.iid.wf.ks.p)}, share ${fmt(c.iid.wf.share05)} ${c.iid.pass ? 'PASS' : 'FAIL'}`);
      console.log(`planted: step 2 p <= 0.01 on ${c.planted.isAt01}/10, step 4 on ${c.planted.wfAt01}/10 ${c.planted.pass ? 'PASS' : 'FAIL'}`);
      console.log(`garch (reported): step 2 KS p ${fmt(c.garch.is.ks.p)}, step 4 KS p ${fmt(c.garch.wf.ks.p)}`);
      console.log(`carry-only (reported): step 2 p <= 0.01 on ${c.carry.isAt01}/10, step 4 on ${c.carry.wfAt01}/10`);
      const t = c.timing;
      console.log(`mean wall time: one cell ${t.oneCellMs.toFixed(0)} ms, 12 cells ${t.twelveCellsMs.toFixed(0)} ms, permutation step 2 ${t.isPermutationMs.toFixed(0)} ms, step 4 ${t.wfPermutationMs.toFixed(0)} ms`);
      console.log(`CALIBRATION ${c.pass ? 'PASS' : 'FAIL'}`);
      process.exit(c.pass ? 0 : 2);
    } else {
      throw new Error('usage: rv-judge.ts jobs|merge|dsr|verdict|check-calibration (see the header)');
    }
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (require.main === module) main();
