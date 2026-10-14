/**
 * The compute stages of the rv-v1 re-validation (header scripts/research/rv-revalidation.ts, Task 7B addendum
 * rules 10 to 12). The 7C runner calls each in a container, one stage per call:
 *
 *   rv-stages.ts inputs    --dataset-dir D --out-dir O --expect-manifest-hash H
 *   rv-stages.ts real      --inputs-dir O --expect-manifest-hash H --out real.json
 *   rv-stages.ts shard     --stage is-mcpt|wf-mcpt|block --name N --inputs-dir O --expect-manifest-hash H --out N.jsonl
 *   rv-stages.ts calibrate --name cal-<kind>-<k> --out cal-<kind>-<k>.json
 *
 * Every stage takes the commit it runs at from GIT_COMMIT. Only `inputs` reads the export and calls Binance REST
 * (draftResolutions, then verifyResolutions on the bytes it wrote, then buildRvPanel). It writes the panel and
 * its first-hour bars as one gzipped canonical JSON file and a record of the manifest hash, panel sha256,
 * first-hour sha256, resolutions sha256 and entry count, and GIT_COMMIT. Every later stage loads that file,
 * recomputes both hashes and refuses on any mismatch with the record, the expected manifest hash or its own
 * GIT_COMMIT (loadInputs). Calibration reads no real data.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { z } from 'zod';

import { RV_V1, type RvConfig } from '@/lib/signals/cross-sectional/engine';
import { stableStringify } from './broad-trend';
import {
  BLOCK_M,
  CALIBRATION_BARS,
  CALIBRATION_UNIVERSES,
  IS_M,
  RV_SEEDS,
  RV_V1_CELL_INDEX,
  RV_WF_GEOMETRY,
  WF_M,
  assertDistinctSeeds,
  blockShard,
  calibrationSeedGroups,
  insampleShard,
  objective,
  prepareSteps,
  realStudySeedGroups,
  runCells,
  walkForward,
  wfShard,
  type NullLine,
  type StepDetail,
  type UniverseKind,
  type WfFold,
  type WfGeometry,
} from './rv-mcpt';
import {
  RV_SPAN,
  RV_SYMBOLS,
  buildRvPanel,
  panelFundingFlags,
  panelGrid,
  panelSha256,
  readPanelSources,
  type FirstHourBars,
  type ResolutionsRecord,
  type RvPanel,
  type Span,
} from './rv-panel';
import { draftResolutions, verifyResolutions, type FundingFetcher } from './rv-resolutions';
import { syntheticPanel } from './rv-synthetic';

/** The files the `inputs` stage writes. */
export const INPUTS_FILES = {
  panel: 'panel.json.gz',
  record: 'inputs.json',
  resolutions: 'resolutions.json',
} as const;

/** Addendum rule 9, AMENDMENT 2: one line in RESULT and in the verdict output. */
export const FUNDING_MARK_NOTE =
  'Funding is charged at the fill price (the previous 8h open), not at the settlement mark price, because the panel carries no settlement mark price.';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** The commit a stage runs at, from GIT_COMMIT (40 hex), or a refusal. */
export function gitCommitFromEnv(env: Record<string, string | undefined> = process.env): string {
  const c = env.GIT_COMMIT ?? '';
  if (!HEX40.test(c)) throw new Error(`REFUSE: GIT_COMMIT must be the 40-hex commit the stage runs at, got '${c}'`);
  return c;
}

/** What every stage output carries and every later stage checks. */
export interface Provenance {
  manifestHash: string;
  panelSha256: string;
  gitCommit: string;
}

export interface InputsRecord {
  stage: 'inputs';
  version: 1;
  manifestHash: string;
  panelSha256: string;
  firstHourSha256: string;
  resolutions: ResolutionsRecord;
  gitCommit: string;
  span: { from: string; to: string };
  bars: number;
  symbols: string[];
  firstBar: string;
  lastBar: string;
}

const RecordSchema = z.object({
  stage: z.literal('inputs'),
  version: z.literal(1),
  manifestHash: z.string().regex(HEX64),
  panelSha256: z.string().regex(HEX64),
  firstHourSha256: z.string().regex(HEX64),
  resolutions: z.object({
    sha256: z.string().regex(HEX64),
    entries: z.number().int().min(0),
    flags: z.array(z.object({ symbol: z.string(), t: z.number(), reason: z.enum(['missing', 'derived-switch']) })),
  }),
  gitCommit: z.string().regex(HEX40),
  span: z.object({ from: z.string(), to: z.string() }),
  bars: z.number().int().positive(),
  symbols: z.array(z.string()),
  firstBar: z.string(),
  lastBar: z.string(),
});

const sha256Of = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
const iso = (t: number) => new Date(t).toISOString();

/**
 * Writes the panel and its first-hour bars as one gzipped canonical JSON file, then the record (last, so a record
 * means a complete stage). Refuses a directory that already holds either file.
 */
export function writeInputs(
  outDir: string,
  input: { panel: RvPanel; firstHour: FirstHourBars; manifestHash: string; resolutions: ResolutionsRecord; gitCommit: string; span: Span }
): InputsRecord {
  mkdirSync(outDir, { recursive: true });
  for (const f of [INPUTS_FILES.panel, INPUTS_FILES.record]) {
    if (existsSync(join(outDir, f))) throw new Error(`REFUSE: ${join(outDir, f)} exists: the inputs stage writes once`);
  }
  const { panel, firstHour } = input;
  const record: InputsRecord = {
    stage: 'inputs',
    version: 1,
    manifestHash: input.manifestHash,
    panelSha256: panelSha256(panel),
    firstHourSha256: sha256Of(firstHour),
    resolutions: input.resolutions,
    gitCommit: input.gitCommit,
    span: { from: iso(input.span.from), to: iso(input.span.to) },
    bars: panel.t.length,
    symbols: [...panel.symbols],
    firstBar: iso(panel.t[0]),
    lastBar: iso(panel.t[panel.t.length - 1]),
  };
  RecordSchema.parse(record);
  writeFileSync(join(outDir, INPUTS_FILES.panel), gzipSync(stableStringify({ firstHour, panel })));
  writeFileSync(join(outDir, INPUTS_FILES.record), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export interface LoadedInputs {
  panel: RvPanel;
  firstHour: FirstHourBars;
  record: InputsRecord;
  provenance: Provenance;
}

/**
 * Addendum rule 12: loads the recorded panel and refuses to run unless the record's manifest hash is the expected
 * one, the record's commit is this stage's GIT_COMMIT, and the panel and first-hour sha256 recomputed from the file
 * equal the record's.
 */
export function loadInputs(dir: string, expect: { manifestHash: string; gitCommit: string }): LoadedInputs {
  const record = RecordSchema.parse(JSON.parse(readFileSync(join(dir, INPUTS_FILES.record), 'utf8'))) as InputsRecord;
  if (record.manifestHash !== expect.manifestHash) {
    throw new Error(`REFUSE: the inputs record's manifest hash ${record.manifestHash} is not the expected ${expect.manifestHash}`);
  }
  if (record.gitCommit !== expect.gitCommit) {
    throw new Error(`REFUSE: the inputs were built at commit ${record.gitCommit}, this stage runs at ${expect.gitCommit}`);
  }
  const parsed = JSON.parse(gunzipSync(readFileSync(join(dir, INPUTS_FILES.panel))).toString('utf8')) as { panel: RvPanel; firstHour: FirstHourBars };
  const sha = panelSha256(parsed.panel);
  if (sha !== record.panelSha256) throw new Error(`REFUSE: the panel sha256 ${sha} recomputed from the file is not the recorded ${record.panelSha256}`);
  const fh = sha256Of(parsed.firstHour);
  if (fh !== record.firstHourSha256) throw new Error(`REFUSE: the first-hour sha256 ${fh} is not the recorded ${record.firstHourSha256}`);
  return {
    panel: parsed.panel,
    firstHour: parsed.firstHour,
    record,
    provenance: { manifestHash: record.manifestHash, panelSha256: record.panelSha256, gitCommit: record.gitCommit },
  };
}

// ------------------------------------------------------------------------------------------------ inputs

/**
 * The `inputs` stage (addendum rule 12). Reads the manifest-verified export, drafts a no-event resolution for every
 * funding flag from REST and halts on any flag REST does not clear, writes the resolutions file, verifies those
 * bytes against REST (AMENDMENTS 1 and 3), builds the panel with every HALT rule and writes it with its record.
 * `fetchFunding` must be fetchFundingHistory (the CLI passes it). Nothing is written before the build passes,
 * apart from the resolutions file the verification reads back.
 */
export async function runInputsStage(opts: {
  datasetDir: string;
  outDir: string;
  span: Span;
  fetchFunding: FundingFetcher;
  gitCommit: string;
  expectManifestHash: string;
}): Promise<InputsRecord> {
  if (!HEX40.test(opts.gitCommit)) throw new Error(`REFUSE: gitCommit must be 40 hex, got '${opts.gitCommit}'`);
  mkdirSync(opts.outDir, { recursive: true });
  for (const f of Object.values(INPUTS_FILES)) {
    if (existsSync(join(opts.outDir, f))) throw new Error(`REFUSE: ${join(opts.outDir, f)} exists: the inputs stage writes once`);
  }
  const { sources, manifestHash } = readPanelSources(opts.datasetDir);
  if (manifestHash !== opts.expectManifestHash) {
    throw new Error(`HALT: the export's manifest hash ${manifestHash} is not the expected ${opts.expectManifestHash}`);
  }
  const flags = panelFundingFlags(sources, opts.span);
  const draft = await draftResolutions(flags, opts.fetchFunding);
  if (draft.unresolved.length > 0) {
    const listed = draft.unresolved.map((u) => `${u.flag.symbol} ${iso(u.flag.t)} (${u.flag.reason}): ${u.reason}`);
    throw new Error(`HALT: ${draft.unresolved.length} funding flag(s) are not cleared by REST: ${listed.join('; ')}`);
  }
  const resolutionsPath = join(opts.outDir, INPUTS_FILES.resolutions);
  writeFileSync(resolutionsPath, draft.content);
  const verified = await verifyResolutions(readFileSync(resolutionsPath), opts.fetchFunding);
  const built = await buildRvPanel(opts.datasetDir, opts.span, verified);
  if (built.meta.manifestHash !== opts.expectManifestHash) {
    throw new Error(`HALT: the manifest hash changed during the stage: ${built.meta.manifestHash}`);
  }
  return writeInputs(opts.outDir, {
    panel: built.panel,
    firstHour: built.firstHour,
    manifestHash: built.meta.manifestHash,
    resolutions: built.meta.resolutions,
    gitCommit: opts.gitCommit,
    span: opts.span,
  });
}

// ------------------------------------------------------------------------------------------------ real

/** Header REPORTED: one combined stress run at 1.5x fees (both, though the taker track pays only the taker fee) and 2x slippage. */
export const STRESS_COSTS: RvConfig['costs'] = {
  takerFee: RV_V1.costs.takerFee * 1.5,
  makerFee: RV_V1.costs.makerFee * 1.5,
  takerSlippageBps: RV_V1.costs.takerSlippageBps * 2,
};

export interface RealOutput {
  stage: 'real';
  provenance: Provenance;
  bars: number;
  /** Bar opens: step k's return starts at t[k]. */
  t: number[];
  firstStep: number;
  geometry: WfGeometry;
  step1: { objectives: number[]; best: number; bestCell: number; returns: number[][] };
  rvV1: { returns: number[]; detail: StepDetail };
  stress: { costs: RvConfig['costs']; returns: number[]; objective: number };
  maker: { returns: number[]; detail: StepDetail; objective: number };
  step3: { folds: WfFold[]; remainder: number; firstStep: number; returns: number[]; objective: number; detail: StepDetail };
  purge: { folds: WfFold[]; returns: number[]; objective: number };
  fundingMarkNote: string;
}

/**
 * The `real` stage: step 1 (all 12 cells on the full span), rv-v1's decomposition, the stress run and the maker
 * track (cell 11 only, addendum rule 10), step 3 at the header geometry and its 1-bar purge sensitivity.
 */
export function runRealStage(inputs: LoadedInputs): RealOutput {
  const { panel, firstHour } = inputs;
  const prep = prepareSteps(panel);
  const cells = runCells(panel, { prepared: prep });
  const best = Math.max(...cells.objectives);
  const rvV1 = runCells(panel, { prepared: prep, cells: [RV_V1_CELL_INDEX], detail: true }).runs[0];
  const stress = runCells(panel, { prepared: prep, cells: [RV_V1_CELL_INDEX], costs: STRESS_COSTS }).runs[0];
  const maker = runCells(panel, { prepared: prep, cells: [RV_V1_CELL_INDEX], maker: firstHour, detail: true }).runs[0];
  const wf = walkForward(panel, RV_WF_GEOMETRY, { prepared: prep, cells, detail: true });
  const purged = walkForward(panel, RV_WF_GEOMETRY, { prepared: prep, cells, purge: 1 });
  return {
    stage: 'real',
    provenance: inputs.provenance,
    bars: panel.t.length,
    t: [...panel.t],
    firstStep: cells.firstStep,
    geometry: RV_WF_GEOMETRY,
    step1: { objectives: cells.objectives, best, bestCell: cells.objectives.indexOf(best), returns: cells.runs.map((r) => r.returns) },
    rvV1: { returns: rvV1.returns, detail: rvV1.detail! },
    stress: { costs: STRESS_COSTS, returns: stress.returns, objective: objective(stress.returns) },
    maker: { returns: maker.returns, detail: maker.detail!, objective: objective(maker.returns) },
    step3: { folds: wf.folds, remainder: wf.remainder, firstStep: wf.firstStep, returns: wf.returns, objective: wf.objective, detail: wf.detail! },
    purge: { folds: purged.folds, returns: purged.returns, objective: purged.objective },
    fundingMarkNote: FUNDING_MARK_NOTE,
  };
}

// ------------------------------------------------------------------------------------------------ shards

export type ShardStage = 'is-mcpt' | 'wf-mcpt' | 'block';

/** Permutations per shard: 8 shards of 125 cover each stage's M = 1,000. */
export const SHARD_SIZE = 125;

const STAGE_M: Record<ShardStage, number> = { 'is-mcpt': IS_M, 'wf-mcpt': WF_M, block: BLOCK_M };

export interface ShardJob {
  name: string;
  stage: ShardStage;
  mFrom: number;
  mTo: number;
}

/** The shard jobs of a stage, named <stage>-NN, covering m = 1..M once. */
export function shardJobs(stage: ShardStage): ShardJob[] {
  const M = STAGE_M[stage];
  if (M === undefined) throw new Error(`unknown shard stage ${stage}`);
  const count = Math.ceil(M / SHARD_SIZE);
  return Array.from({ length: count }, (_, i) => ({
    name: `${stage}-${String(i + 1).padStart(2, '0')}`,
    stage,
    mFrom: i * SHARD_SIZE + 1,
    mTo: Math.min(M, (i + 1) * SHARD_SIZE),
  }));
}

/** The seed rule of a stage (header SEEDS). */
export function stageSeed(stage: ShardStage): (m: number) => number {
  return stage === 'is-mcpt' ? RV_SEEDS.is : stage === 'wf-mcpt' ? RV_SEEDS.wf : RV_SEEDS.block;
}

export interface ShardHeader {
  kind: 'header';
  stage: ShardStage;
  name: string;
  mFrom: number;
  mTo: number;
  M: number;
  provenance: Provenance;
}

/**
 * Runs permutations mFrom..mTo of a stage and returns the shard file: a provenance header line, then one JSON line
 * per permutation. Asserts first that every seed of the real study is distinct after the >>> 0 reduction
 * (AMENDMENT 1, addendum rule 6).
 */
export function runShard(stage: ShardStage, name: string, mFrom: number, mTo: number, inputs: LoadedInputs): string {
  assertDistinctSeeds(realStudySeedGroups());
  const seedOf = stageSeed(stage);
  const lines: NullLine[] =
    stage === 'is-mcpt'
      ? insampleShard(inputs.panel, mFrom, mTo, seedOf)
      : stage === 'wf-mcpt'
        ? wfShard(inputs.panel, mFrom, mTo, seedOf, RV_WF_GEOMETRY)
        : blockShard(inputs.panel, mFrom, mTo, seedOf);
  const header: ShardHeader = { kind: 'header', stage, name, mFrom, mTo, M: STAGE_M[stage], provenance: inputs.provenance };
  return [header, ...lines].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** The `shard` stage: runs one job of shardJobs(stage) by name, and nothing else. */
export function runShardStage(stage: ShardStage, name: string, inputs: LoadedInputs): string {
  const job = shardJobs(stage).find((j) => j.name === name);
  if (!job) throw new Error(`REFUSE: ${name} is not a listed job of ${stage}`);
  return runShard(stage, job.name, job.mFrom, job.mTo, inputs);
}

// ------------------------------------------------------------------------------------------------ calibration

export interface CalibrationJob {
  name: string;
  kind: UniverseKind;
  k: number;
}

const KIND_ORDER: UniverseKind[] = ['iid', 'planted', 'garch', 'carry'];

/** Header CALIBRATION: one job per universe seed, iid 1..100, planted 1..10, GARCH 1..10, carry-only 1..10. */
export function calibrationJobs(): CalibrationJob[] {
  return KIND_ORDER.flatMap((kind) =>
    Array.from({ length: CALIBRATION_UNIVERSES[kind].count }, (_, i) => ({ name: `cal-${kind}-${String(i + 1).padStart(3, '0')}`, kind, k: i + 1 }))
  );
}

/** The size of a calibration run. The header's: 3,000 bars, the header geometry, each universe's own M. */
export interface CalibrationScale {
  bars: number;
  geometry: WfGeometry;
  /** null: the universe's M (CALIBRATION_UNIVERSES). A number only in the fast tests. */
  M: number | null;
}

export const HEADER_CALIBRATION_SCALE: CalibrationScale = { bars: CALIBRATION_BARS, geometry: RV_WF_GEOMETRY, M: null };

export interface CalibrationOutput {
  stage: 'calibrate';
  kind: UniverseKind;
  k: number;
  seed: number;
  bars: number;
  geometry: WfGeometry;
  M: number;
  gitCommit: string;
  is: { real: number; perCell: number[]; nulls: NullLine[] };
  wf: { real: number; cells: number[]; nulls: NullLine[] };
  /** Wall times in ms (addendum rule 11). */
  timing: { prepareMs: number; oneCellMs: number; twelveCellsMs: number; isPermutationMs: number; wfPermutationMs: number };
}

/**
 * One calibration universe (header CALIBRATION ACCEPTANCE): the synthetic panel of seed spec.seed(k), the real
 * step 2 and step 4 statistics, and M permutations each with inner seeds s * 10,000 + m. Records wall times.
 */
export function runCalibrationJob(kind: UniverseKind, k: number, gitCommit: string, scale: CalibrationScale): CalibrationOutput {
  const spec = CALIBRATION_UNIVERSES[kind];
  if (!spec) throw new Error(`unknown calibration universe kind ${kind}`);
  if (!Number.isInteger(k) || k < 1 || k > spec.count) throw new Error(`k must be an integer in [1, ${spec.count}] for ${kind}, got ${k}`);
  assertDistinctSeeds(calibrationSeedGroups());
  const seed = spec.seed(k);
  const M = scale.M ?? spec.M;
  const panel = syntheticPanel({ bars: scale.bars, symbols: RV_SYMBOLS.length, mode: spec.mode, strength: spec.strength, seed });

  let t0 = performance.now();
  const prep = prepareSteps(panel);
  const prepareMs = performance.now() - t0;
  t0 = performance.now();
  runCells(panel, { prepared: prep, cells: [RV_V1_CELL_INDEX] });
  const oneCellMs = performance.now() - t0;
  t0 = performance.now();
  const cells = runCells(panel);
  const twelveCellsMs = performance.now() - t0;
  const wf = walkForward(panel, scale.geometry, { prepared: prep, cells });

  const inner = (m: number) => RV_SEEDS.inner(seed, m);
  t0 = performance.now();
  const isNulls = insampleShard(panel, 1, M, inner);
  const isPermutationMs = (performance.now() - t0) / M;
  t0 = performance.now();
  const wfNulls = wfShard(panel, 1, M, inner, scale.geometry);
  const wfPermutationMs = (performance.now() - t0) / M;

  return {
    stage: 'calibrate',
    kind,
    k,
    seed,
    bars: scale.bars,
    geometry: scale.geometry,
    M,
    gitCommit,
    is: { real: Math.max(...cells.objectives), perCell: cells.objectives, nulls: isNulls },
    wf: { real: wf.objective, cells: wf.folds.map((f) => f.cell), nulls: wfNulls },
    timing: { prepareMs, oneCellMs, twelveCellsMs, isPermutationMs, wfPermutationMs },
  };
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

const SHARD_STAGES: readonly ShardStage[] = ['is-mcpt', 'wf-mcpt', 'block'];

async function main(): Promise<void> {
  try {
    const [mode, ...rest] = process.argv.slice(2);
    const gitCommit = gitCommitFromEnv();
    if (mode === 'inputs') {
      const a = flags(rest, ['dataset-dir', 'out-dir', 'expect-manifest-hash']);
      const { fetchFundingHistory } = await import('@/lib/snapshot-backfill');
      const record = await runInputsStage({
        datasetDir: a['dataset-dir'],
        outDir: a['out-dir'],
        span: RV_SPAN,
        fetchFunding: fetchFundingHistory,
        gitCommit,
        expectManifestHash: a['expect-manifest-hash'],
      });
      console.log(JSON.stringify(record));
      console.log(`grid ${JSON.stringify(panelGrid(RV_SPAN))}`);
    } else if (mode === 'real') {
      const a = flags(rest, ['inputs-dir', 'expect-manifest-hash', 'out']);
      const inputs = loadInputs(a['inputs-dir'], { manifestHash: a['expect-manifest-hash'], gitCommit });
      const t0 = performance.now();
      const out = runRealStage(inputs);
      writeFileSync(a.out, JSON.stringify(out));
      console.log(`real: best cell ${out.step1.bestCell} objective ${out.step1.best}, walk-forward ${out.step3.objective}, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    } else if (mode === 'shard') {
      const a = flags(rest, ['stage', 'name', 'inputs-dir', 'expect-manifest-hash', 'out']);
      if (!SHARD_STAGES.includes(a.stage as ShardStage)) throw new Error(`--stage must be one of ${SHARD_STAGES.join(', ')}`);
      const inputs = loadInputs(a['inputs-dir'], { manifestHash: a['expect-manifest-hash'], gitCommit });
      const t0 = performance.now();
      writeFileSync(a.out, runShardStage(a.stage as ShardStage, a.name, inputs));
      console.log(`${a.name}: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    } else if (mode === 'calibrate') {
      const a = flags(rest, ['name', 'out']);
      const job = calibrationJobs().find((j) => j.name === a.name);
      if (!job) throw new Error(`REFUSE: ${a.name} is not a listed calibration job`);
      const out = runCalibrationJob(job.kind, job.k, gitCommit, HEADER_CALIBRATION_SCALE);
      writeFileSync(a.out, JSON.stringify(out));
      const t = out.timing;
      console.log(
        `${a.name}: one cell run ${t.oneCellMs.toFixed(0)} ms (factors ${t.prepareMs.toFixed(0)} ms, 12 cells ${t.twelveCellsMs.toFixed(0)} ms), ` +
          `per permutation step 2 ${t.isPermutationMs.toFixed(0)} ms, step 4 ${t.wfPermutationMs.toFixed(0)} ms`
      );
    } else {
      throw new Error('usage: rv-stages.ts inputs|real|shard|calibrate --flags (see the header)');
    }
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (require.main === module) void main();
