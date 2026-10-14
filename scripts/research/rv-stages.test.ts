// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gunzipSync, gzipSync } from 'zlib';

import { RV_V1 } from '@/lib/signals/cross-sectional/engine';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import { stableStringify } from './broad-trend';
import { datasetHashOf, sha256File, writeJsonlGz, type DatasetManifest, type FundingRow, type ManifestFile, type PerpCandleRow } from './dataset-format';
import { RV_SYMBOLS, panelSha256, type FirstHourBars, type RvPanel } from './rv-panel';
import { permutePanel } from './rv-permute';
import {
  CALIBRATION_UNIVERSES,
  RV_SEEDS,
  RV_WF_GEOMETRY,
  insampleShard,
  runCells,
  walkForward,
  wfShard,
} from './rv-mcpt';
import type { FundingFetcher } from './rv-resolutions';
import { syntheticPanel } from './rv-synthetic';
import {
  FUNDING_MARK_NOTE,
  INPUTS_FILES,
  calibrationJobs,
  gitCommitFromEnv,
  loadInputs,
  runCalibrationJob,
  runInputsStage,
  runRealStage,
  runResolveStage,
  runShard,
  runShardStage,
  shardJobs,
  writeInputs,
} from './rv-stages';

const H = 3_600_000;
const H4 = 4 * H;
const H8 = 8 * H;
const DAY = 24 * H;
const T0 = Date.UTC(2022, 0, 1);
const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** A synthetic first-hour series: open at the bar open, a range around it, a close 0.1% away. */
function firstHourOf(p: RvPanel): FirstHourBars {
  return {
    open: p.open.map((row) => [...row]),
    high: p.open.map((row) => row.map((o) => o * 1.002)),
    low: p.open.map((row) => row.map((o) => o * 0.998)),
    close: p.open.map((row, s) => row.map((o, k) => o * (1 + (((s + k) % 3) - 1) * 0.001))),
  };
}

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

describe('inputs files and provenance (addendum rule 12)', () => {
  let dir: string;
  const panel = syntheticPanel({ bars: 120, symbols: 10, mode: 'planted', strength: 1, seed: 4 });
  const firstHour = firstHourOf(panel);
  const fields = {
    manifestHash: 'c'.repeat(64),
    resolutions: { sha256: 'd'.repeat(64), entries: 0, flags: [] },
    gitCommit: COMMIT,
    span: { from: T0, to: T0 + 40 * DAY - 1 },
  };
  beforeEach(() => {
    dir = tmp('rv-inputs-');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the panel as gzipped canonical JSON with a record, and loads it back with every hash recomputed', () => {
    const record = writeInputs(dir, { panel, firstHour, ...fields });
    expect(record.panelSha256).toBe(panelSha256(panel));
    expect(record.firstHourSha256).toBe(createHash('sha256').update(stableStringify(firstHour)).digest('hex'));
    expect(record).toMatchObject({ stage: 'inputs', manifestHash: fields.manifestHash, gitCommit: COMMIT, bars: 120, symbols: [...RV_SYMBOLS] });
    const raw = gunzipSync(readFileSync(join(dir, INPUTS_FILES.panel))).toString('utf8');
    expect(raw).toBe(stableStringify({ firstHour, panel }));
    const loaded = loadInputs(dir, { manifestHash: fields.manifestHash, gitCommit: COMMIT });
    expect(loaded.panel).toEqual(panel);
    expect(loaded.firstHour).toEqual(firstHour);
    expect(loaded.record).toEqual(record);
    expect(loaded.provenance).toEqual({ manifestHash: fields.manifestHash, panelSha256: record.panelSha256, gitCommit: COMMIT });
  });

  it('refuses a second write into the same directory', () => {
    writeInputs(dir, { panel, firstHour, ...fields });
    expect(() => writeInputs(dir, { panel, firstHour, ...fields })).toThrow(/exists/);
  });

  it('refuses to run on a wrong manifest hash, a wrong commit, or a panel or first-hour file that no longer matches', () => {
    writeInputs(dir, { panel, firstHour, ...fields });
    expect(() => loadInputs(dir, { manifestHash: 'e'.repeat(64), gitCommit: COMMIT })).toThrow(/REFUSE[\s\S]*manifest/);
    expect(() => loadInputs(dir, { manifestHash: fields.manifestHash, gitCommit: OTHER })).toThrow(/REFUSE[\s\S]*commit/);
    const path = join(dir, INPUTS_FILES.panel);
    const original = readFileSync(path);
    const changed = structuredClone(panel);
    changed.close[3][50] *= 1.0000001;
    writeFileSync(path, gzipSync(stableStringify({ firstHour, panel: changed })));
    expect(() => loadInputs(dir, { manifestHash: fields.manifestHash, gitCommit: COMMIT })).toThrow(/REFUSE[\s\S]*panel sha256/);
    const fh = structuredClone(firstHour);
    fh.low[0][0] *= 0.9;
    writeFileSync(path, gzipSync(stableStringify({ firstHour: fh, panel })));
    expect(() => loadInputs(dir, { manifestHash: fields.manifestHash, gitCommit: COMMIT })).toThrow(/REFUSE[\s\S]*first-hour/);
    writeFileSync(path, original);
    expect(() => loadInputs(dir, { manifestHash: fields.manifestHash, gitCommit: COMMIT })).not.toThrow();
    const rec = JSON.parse(readFileSync(join(dir, INPUTS_FILES.record), 'utf8'));
    rec.panelSha256 = '0'.repeat(64);
    writeFileSync(join(dir, INPUTS_FILES.record), JSON.stringify(rec));
    expect(() => loadInputs(dir, { manifestHash: fields.manifestHash, gitCommit: COMMIT })).toThrow(/REFUSE[\s\S]*panel sha256/);
  });

  it('reads GIT_COMMIT as a 40-hex commit or refuses', () => {
    expect(gitCommitFromEnv({ GIT_COMMIT: COMMIT })).toBe(COMMIT);
    expect(() => gitCommitFromEnv({})).toThrow(/GIT_COMMIT/);
    expect(() => gitCommitFromEnv({ GIT_COMMIT: 'abc' })).toThrow(/GIT_COMMIT/);
  });
});

// ------------------------------------------------------------------------------------------------ inputs stage

/** Eight 1h rows per 8h bucket, a seeded walk. */
function hourly(buckets: number, seed: number): PerpCandleRow[] {
  const random = createSeededRandom(seed);
  const rows: PerpCandleRow[] = [];
  let price = 100 + seed;
  for (let i = 0; i < buckets * 8; i++) {
    const o = price;
    const c = o * (1 + (random() - 0.5) * 0.01);
    const v = 100 + random() * 900;
    rows.push({ t: T0 + i * H, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v, qv: v * o, n: 50, tbv: v * 0.5 });
    price = c;
  }
  return rows;
}

function fourHourly(rows: PerpCandleRow[]): PerpCandleRow[] {
  const out: PerpCandleRow[] = [];
  for (let i = 0; i + 4 <= rows.length; i += 4) {
    const g = rows.slice(i, i + 4);
    out.push({
      t: g[0].t,
      o: g[0].o,
      h: Math.max(...g.map((r) => r.h)),
      l: Math.min(...g.map((r) => r.l)),
      c: g[3].c,
      v: g.reduce((s, r) => s + r.v, 0),
      qv: g.reduce((s, r) => s + r.qv, 0),
      n: 200,
      tbv: g.reduce((s, r) => s + (r.tbv as number), 0),
    });
  }
  return out;
}

const grid = (from: number, to: number, hours: number): FundingRow[] => {
  const out: FundingRow[] = [];
  for (let t = from; t <= to; t += hours * H) out.push({ t, rate: 0.0001 + (t % 5) * 1e-6, intervalHours: hours });
  return out;
};

const BUCKETS = 9;
const SPAN = { from: T0, to: T0 + 3 * DAY - 1 };
/** SOLUSDT on the A6-1 shape: stated 8h rows to day 2 00:00, then stated 2h rows from 04:00, so 02:00 is flagged. */
const FLAG_T = T0 + 2 * DAY + 2 * H;

async function writeExport(dir: string, a61: boolean, opts: { nanRates?: boolean; unreadablePerp?: boolean } = {}): Promise<string> {
  const files: ManifestFile[] = [];
  const put = async (rel: string, kind: ManifestFile['kind'], symbol: string, interval: string, rows: { t: number }[]) => {
    const path = join(dir, rel);
    await writeJsonlGz(path, rows);
    files.push({ path: rel, kind, symbol, interval, rowCount: rows.length, startMs: rows[0].t, endMs: rows[rows.length - 1].t, sha256: await sha256File(path) });
  };
  for (const [i, symbol] of RV_SYMBOLS.entries()) {
    const rows1h = hourly(BUCKETS, 500 + i);
    let funding = grid(T0 + H8, SPAN.to, 8);
    if (a61 && symbol === 'SOLUSDT') funding = [...grid(T0 + H8, T0 + 2 * DAY, 8), ...grid(T0 + 2 * DAY + H4, SPAN.to, 2)];
    if (opts.nanRates) funding = funding.map((r) => ({ ...r, rate: NaN }));
    await put(`perp/${symbol}/4h.jsonl.gz`, 'perp', symbol, '4h', fourHourly(rows1h));
    await put(`perp/${symbol}/1h.jsonl.gz`, 'perp', symbol, '1h', rows1h);
    await put(`funding/${symbol}/settlements.jsonl.gz`, 'funding', symbol, 'settlements', funding);
  }
  const manifest: DatasetManifest = {
    version: 1,
    generatedAt: new Date(T0).toISOString(),
    commit: 'fixture',
    lockboxStart: new Date(Date.UTC(2026, 6, 1)).toISOString(),
    symbols: [...RV_SYMBOLS],
    intervals: ['1h', '4h'],
    files,
    datasetHash: datasetHashOf(files),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // bytes that are not even gzip, under the manifest's recorded hashes: any read of a price or volume fails
  if (opts.unreadablePerp) for (const f of files.filter((x) => x.kind === 'perp')) writeFileSync(join(dir, f.path), 'not a kline file');
  return manifest.datasetHash;
}

/** REST settled at the export's own settlement times, so a no-event flag between two of them verifies. */
async function restLikeExport(dir: string): Promise<FundingFetcher> {
  const { readPanelSources } = await import('./rv-panel');
  const { sources } = readPanelSources(dir);
  const times = Object.fromEntries(sources.map((s) => [s.symbol, s.funding.map((r) => r.t)]));
  return async (symbol, startTime, endTime) => (times[symbol] ?? []).filter((t) => t >= startTime && t <= endTime).map((fundingTime) => ({ fundingTime }));
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const A61_ENTRY = {
  symbol: 'SOLUSDT',
  t: new Date(FLAG_T).toISOString(),
  verdict: 'no-event',
  restBefore: new Date(T0 + 2 * DAY).toISOString(),
  restAfter: new Date(T0 + 2 * DAY + H4).toISOString(),
};

describe('runResolveStage (pre-review Ruling 3: flags and a REST draft, then stop)', () => {
  let ds: string;
  let out: string;
  beforeEach(() => {
    ds = tmp('rv-ds-');
    out = tmp('rv-out-');
  });
  afterEach(() => {
    rmSync(ds, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it('drafts the flagged settlement from REST, writes the file and a record of its sha256, and stops', async () => {
    const hash = await writeExport(ds, true);
    const record = await runResolveStage({ datasetDir: ds, outDir: out, span: SPAN, fetchFunding: await restLikeExport(ds), gitCommit: COMMIT, expectManifestHash: hash });
    const bytes = readFileSync(join(out, INPUTS_FILES.resolutions));
    expect(JSON.parse(bytes.toString('utf8')).resolutions).toEqual([A61_ENTRY]);
    expect(record).toEqual({
      stage: 'resolve',
      version: 1,
      manifestHash: hash,
      gitCommit: COMMIT,
      sha256: sha(bytes),
      entries: 1,
      flags: [{ symbol: 'SOLUSDT', t: FLAG_T, reason: 'missing' }],
      span: { from: new Date(SPAN.from).toISOString(), to: new Date(SPAN.to).toISOString() },
    });
    expect(JSON.parse(readFileSync(join(out, INPUTS_FILES.resolveRecord), 'utf8'))).toEqual(record);
    expect(existsSync(join(out, INPUTS_FILES.panel))).toBe(false);
    expect(existsSync(join(out, INPUTS_FILES.record))).toBe(false);
  });

  it('writes an empty file when nothing is flagged', async () => {
    const hash = await writeExport(ds, false);
    const record = await runResolveStage({ datasetDir: ds, outDir: out, span: SPAN, fetchFunding: await restLikeExport(ds), gitCommit: COMMIT, expectManifestHash: hash });
    const bytes = readFileSync(join(out, INPUTS_FILES.resolutions));
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({ resolutions: [] });
    expect(record).toMatchObject({ entries: 0, flags: [], sha256: sha(bytes) });
  });

  it('never reads a rate, price or volume: NaN rates and unreadable perp files resolve the same', async () => {
    const clean = await writeExport(ds, true);
    const rest = await restLikeExport(ds);
    const want = await runResolveStage({ datasetDir: ds, outDir: out, span: SPAN, fetchFunding: rest, gitCommit: COMMIT, expectManifestHash: clean });
    const ds2 = tmp('rv-ds-nan-');
    const out2 = tmp('rv-out-nan-');
    try {
      const hash = await writeExport(ds2, true, { nanRates: true, unreadablePerp: true });
      const got = await runResolveStage({ datasetDir: ds2, outDir: out2, span: SPAN, fetchFunding: rest, gitCommit: COMMIT, expectManifestHash: hash });
      expect({ ...got, manifestHash: '' }).toEqual({ ...want, manifestHash: '' });
      expect(readFileSync(join(out2, INPUTS_FILES.resolutions))).toEqual(readFileSync(join(out, INPUTS_FILES.resolutions)));
      // the fixture has teeth: the panel cannot be built from it
      const { readPanelSources } = await import('./rv-panel');
      expect(() => readPanelSources(ds2)).toThrow(/HALT[\s\S]*sha256[\s\S]*perp/);
    } finally {
      rmSync(ds2, { recursive: true, force: true });
      rmSync(out2, { recursive: true, force: true });
    }
  });

  it('halts when REST shows a settlement at a flagged instant, and writes nothing', async () => {
    const hash = await writeExport(ds, true);
    const rest = await restLikeExport(ds);
    const settledThere: FundingFetcher = async (symbol, a, b) => [...(await rest(symbol, a, b)), ...(symbol === 'SOLUSDT' && FLAG_T >= a && FLAG_T <= b ? [{ fundingTime: FLAG_T }] : [])];
    await expect(runResolveStage({ datasetDir: ds, outDir: out, span: SPAN, fetchFunding: settledThere, gitCommit: COMMIT, expectManifestHash: hash })).rejects.toThrow(
      /HALT[\s\S]*SOLUSDT[\s\S]*REST shows a settlement/
    );
    expect(existsSync(join(out, INPUTS_FILES.resolutions))).toBe(false);
    expect(existsSync(join(out, INPUTS_FILES.resolveRecord))).toBe(false);
  });

  it('refuses an existing file in the directory, leaving it untouched, and a manifest hash other than the expected one', async () => {
    const hash = await writeExport(ds, true);
    const rest = await restLikeExport(ds);
    await expect(runResolveStage({ datasetDir: ds, outDir: out, span: SPAN, fetchFunding: rest, gitCommit: COMMIT, expectManifestHash: 'f'.repeat(64) })).rejects.toThrow(/HALT[\s\S]*manifest/);
    writeFileSync(join(out, INPUTS_FILES.resolutions), 'recorded earlier');
    await expect(runResolveStage({ datasetDir: ds, outDir: out, span: SPAN, fetchFunding: rest, gitCommit: COMMIT, expectManifestHash: hash })).rejects.toThrow(/REFUSE[\s\S]*resolutions\.json exists/);
    expect(readFileSync(join(out, INPUTS_FILES.resolutions), 'utf8')).toBe('recorded earlier');
  });
});

describe('runInputsStage (pre-review Ruling 3: verify the reviewed file, then build)', () => {
  let ds: string;
  let out: string;
  let hash: string;
  let rest: FundingFetcher;
  const inputs = (overrides: Partial<Parameters<typeof runInputsStage>[0]> = {}) =>
    runInputsStage({ datasetDir: ds, outDir: out, span: SPAN, resolutionsPath: join(out, INPUTS_FILES.resolutions), fetchFunding: rest, gitCommit: COMMIT, expectManifestHash: hash, ...overrides });
  beforeEach(async () => {
    ds = tmp('rv-ds-');
    out = tmp('rv-out-');
    hash = await writeExport(ds, true);
    rest = await restLikeExport(ds);
    await runResolveStage({ datasetDir: ds, outDir: out, span: SPAN, fetchFunding: rest, gitCommit: COMMIT, expectManifestHash: hash });
  });
  afterEach(() => {
    rmSync(ds, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it('verifies the reviewed file against REST, builds the panel and records every hash', async () => {
    const record = await inputs();
    const bytes = readFileSync(join(out, INPUTS_FILES.resolutions));
    expect(record.resolutions).toEqual({ sha256: sha(bytes), entries: 1, flags: [{ symbol: 'SOLUSDT', t: FLAG_T, reason: 'missing' }] });
    expect(record.resolutions.sha256).toBe(JSON.parse(readFileSync(join(out, INPUTS_FILES.resolveRecord), 'utf8')).sha256);
    const loaded = loadInputs(out, { manifestHash: hash, gitCommit: COMMIT });
    expect(record.manifestHash).toBe(hash);
    expect(loaded.panel.t).toHaveLength(BUCKETS - 1);
    expect(record.panelSha256).toBe(panelSha256(loaded.panel));
    expect(loaded.firstHour.open).toEqual(loaded.panel.open);
  });

  it('refuses a file whose sha256 is not the one resolve recorded, and writes no panel', async () => {
    const path = join(out, INPUTS_FILES.resolutions);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\n$/, '\n\n'));
    await expect(inputs()).rejects.toThrow(/REFUSE[\s\S]*sha256/);
    const elsewhere = join(out, 'other.json');
    writeFileSync(elsewhere, '{"resolutions":[]}\n');
    await expect(inputs({ resolutionsPath: elsewhere })).rejects.toThrow(/REFUSE[\s\S]*sha256/);
    expect(existsSync(join(out, INPUTS_FILES.panel))).toBe(false);
    expect(existsSync(join(out, INPUTS_FILES.record))).toBe(false);
  });

  it('refuses without a resolve record, or with one from another commit or dataset (Ruling 2: no commits between stages)', async () => {
    await expect(inputs({ gitCommit: OTHER })).rejects.toThrow(/REFUSE[\s\S]*commit/);
    const rec = JSON.parse(readFileSync(join(out, INPUTS_FILES.resolveRecord), 'utf8'));
    writeFileSync(join(out, INPUTS_FILES.resolveRecord), JSON.stringify({ ...rec, manifestHash: 'e'.repeat(64) }));
    await expect(inputs()).rejects.toThrow(/REFUSE[\s\S]*manifest/);
    rmSync(join(out, INPUTS_FILES.resolveRecord));
    await expect(inputs()).rejects.toThrow(/REFUSE[\s\S]*resolve/);
  });

  it('halts when REST no longer agrees with the file, and writes no panel', async () => {
    const settledThere: FundingFetcher = async (symbol, a, b) => [...(await rest(symbol, a, b)), ...(symbol === 'SOLUSDT' && FLAG_T >= a && FLAG_T <= b ? [{ fundingTime: FLAG_T }] : [])];
    await expect(inputs({ fetchFunding: settledThere })).rejects.toThrow(/HALT[\s\S]*REST shows a settlement/);
    expect(existsSync(join(out, INPUTS_FILES.panel))).toBe(false);
  });

  it('refuses to run twice into the same directory, before any REST call', async () => {
    await inputs();
    const noRest: FundingFetcher = async () => {
      throw new Error('REST must not be called');
    };
    await expect(inputs({ fetchFunding: noRest })).rejects.toThrow(/REFUSE[\s\S]*exists/);
  });
});

// ------------------------------------------------------------------------------------------------ real and shards

describe('runRealStage (header STEPS 1 and 3, REPORTED inputs)', () => {
  let dir: string;
  const panel = syntheticPanel({ bars: 1700, symbols: 10, mode: 'planted', strength: 1, seed: 31 });
  const firstHour = firstHourOf(panel);
  let loaded: ReturnType<typeof loadInputs>;
  let real: ReturnType<typeof runRealStage>;
  beforeAll(() => {
    dir = tmp('rv-real-');
    writeInputs(dir, { panel, firstHour, manifestHash: 'c'.repeat(64), resolutions: { sha256: 'd'.repeat(64), entries: 0, flags: [] }, gitCommit: COMMIT, span: { from: T0, to: T0 + DAY } });
    loaded = loadInputs(dir, { manifestHash: 'c'.repeat(64), gitCommit: COMMIT });
    real = runRealStage(loaded);
    rmSync(dir, { recursive: true, force: true });
  });

  it('records step 1 for all 12 cells and step 3 at the header geometry, with provenance', () => {
    const cells = runCells(panel);
    expect(real.provenance).toEqual(loaded.provenance);
    expect(real.step1.objectives).toEqual(cells.objectives);
    expect(real.step1.returns).toEqual(cells.runs.map((r) => r.returns));
    expect(real.step1.best).toBe(Math.max(...cells.objectives));
    expect(real.t).toEqual(panel.t);
    expect(real.firstStep).toBe(42);
    const wf = walkForward(panel, RV_WF_GEOMETRY);
    expect(real.step3.objective).toBe(wf.objective);
    expect(real.step3.returns).toEqual(wf.returns);
    expect(real.step3.folds.map((f) => f.cell)).toEqual(wf.folds.map((f) => f.cell));
    expect(real.purge.objective).toBe(walkForward(panel, RV_WF_GEOMETRY, { purge: 1 }).objective);
    expect(real.geometry).toEqual(RV_WF_GEOMETRY);
  });

  it('records rv-v1\'s decomposition, the stress run and the maker track (cell 11 only)', () => {
    const detail = runCells(panel, { cells: [11], detail: true }).runs[0];
    expect(real.rvV1.returns).toEqual(real.step1.returns[11]);
    expect(real.rvV1.detail).toEqual(detail.detail);
    const costs = { takerFee: RV_V1.costs.takerFee * 1.5, makerFee: RV_V1.costs.makerFee * 1.5, takerSlippageBps: RV_V1.costs.takerSlippageBps * 2 };
    expect(real.stress.costs).toEqual(costs);
    expect(real.stress.returns).toEqual(runCells(panel, { cells: [11], costs }).runs[0].returns);
    expect(real.maker.returns).toEqual(runCells(panel, { cells: [11], maker: firstHour, detail: true }).runs[0].returns);
    expect(real.maker.detail.makerFills! + real.maker.detail.fallbackFills!).toBeGreaterThan(0);
    expect(real.fundingMarkNote).toBe(FUNDING_MARK_NOTE);
    expect(FUNDING_MARK_NOTE).toMatch(/fill price/);
  });
});

describe('shards (header STEPS 2 and 4, REPORTED block sensitivity)', () => {
  let dir: string;
  const panel = syntheticPanel({ bars: 1400, symbols: 10, mode: 'iid', strength: 0, seed: 32 });
  let loaded: ReturnType<typeof loadInputs>;
  beforeAll(() => {
    dir = tmp('rv-shard-');
    writeInputs(dir, { panel, firstHour: firstHourOf(panel), manifestHash: 'c'.repeat(64), resolutions: { sha256: 'd'.repeat(64), entries: 0, flags: [] }, gitCommit: COMMIT, span: { from: T0, to: T0 + DAY } });
    loaded = loadInputs(dir, { manifestHash: 'c'.repeat(64), gitCommit: COMMIT });
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists 8 jobs of 125 permutations per stage, covering m = 1..1,000 once', () => {
    for (const stage of ['is-mcpt', 'wf-mcpt', 'block'] as const) {
      const jobs = shardJobs(stage);
      expect(jobs).toHaveLength(8);
      expect(jobs[0]).toEqual({ name: `${stage}-01`, stage, mFrom: 1, mTo: 125 });
      expect(jobs[7]).toEqual({ name: `${stage}-08`, stage, mFrom: 876, mTo: 1000 });
      expect(jobs.flatMap((j) => Array.from({ length: j.mTo - j.mFrom + 1 }, (_, i) => j.mFrom + i))).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
    }
  });

  it('writes a provenance header then one line per permutation with the header seed rule', () => {
    const text = runShard('wf-mcpt', 'wf-mcpt-test', 3, 4, loaded);
    const [header, ...lines] = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(header).toEqual({ kind: 'header', stage: 'wf-mcpt', name: 'wf-mcpt-test', mFrom: 3, mTo: 4, M: 1000, provenance: loaded.provenance });
    expect(lines).toEqual(JSON.parse(JSON.stringify(wfShard(panel, 3, 4, RV_SEEDS.wf, RV_WF_GEOMETRY))));
    const is = runShard('is-mcpt', 'x', 1, 2, loaded).trim().split('\n').slice(1).map((l) => JSON.parse(l));
    expect(is).toEqual(JSON.parse(JSON.stringify(insampleShard(panel, 1, 2, RV_SEEDS.is))));
    expect(is[0].seed).toBe(20261015);
  });

  it('runs a listed job only', () => {
    expect(() => runShardStage('is-mcpt', 'is-mcpt-09', loaded)).toThrow(/not a listed job/);
    expect(() => runShardStage('block', 'is-mcpt-01', loaded)).toThrow(/not a listed job/);
  });
});

// ------------------------------------------------------------------------------------------------ calibration

describe('runCalibrationJob (header CALIBRATION ACCEPTANCE, addendum rules 8 and 11)', () => {
  it('lists the 130 calibration jobs: iid 100, planted 10, GARCH 10, carry-only 10', () => {
    const jobs = calibrationJobs();
    expect(jobs).toHaveLength(130);
    expect(jobs[0]).toEqual({ name: 'cal-iid-001', kind: 'iid', k: 1 });
    expect(jobs[99]).toEqual({ name: 'cal-iid-100', kind: 'iid', k: 100 });
    expect(jobs[100]).toEqual({ name: 'cal-planted-001', kind: 'planted', k: 1 });
    expect(jobs[129]).toEqual({ name: 'cal-carry-010', kind: 'carry', k: 10 });
    expect(CALIBRATION_UNIVERSES.iid.M).toBe(99);
    expect(CALIBRATION_UNIVERSES.planted.M).toBe(199);
  });

  it('runs steps 2 and 4 on one universe with the inner seed rule and reports wall times', () => {
    const scale = { bars: 400, geometry: { train: 150, test: 50 }, M: 4 };
    const out = runCalibrationJob('planted', 2, COMMIT, scale);
    const seed = RV_SEEDS.planted(2);
    expect(out).toMatchObject({ stage: 'calibrate', kind: 'planted', k: 2, seed, bars: 400, M: 4, gitCommit: COMMIT, geometry: scale.geometry });
    const panel = syntheticPanel({ bars: 400, symbols: 10, mode: 'planted', strength: 1, seed });
    expect(out.is.real).toBe(Math.max(...runCells(panel).objectives));
    expect(out.is.nulls).toEqual(insampleShard(panel, 1, 4, (m) => RV_SEEDS.inner(seed, m)));
    expect(out.wf.real).toBe(walkForward(panel, scale.geometry).objective);
    expect(out.wf.nulls.map((l) => l.seed)).toEqual([1, 2, 3, 4].map((m) => seed * 10_000 + m));
    const manual = walkForward(permutePanel(panel, 149, createSeededRandom(seed * 10_000 + 3)), scale.geometry);
    expect(out.wf.nulls[2].best).toBe(manual.objective);
    for (const v of Object.values(out.timing)) expect(v).toBeGreaterThan(0);
  });

  it('refuses a universe kind or index outside the header ranges', () => {
    const scale = { bars: 400, geometry: { train: 150, test: 50 }, M: 1 };
    expect(() => runCalibrationJob('planted', 11, COMMIT, scale)).toThrow(/k/);
    expect(() => runCalibrationJob('iid', 0, COMMIT, scale)).toThrow(/k/);
    expect(() => runCalibrationJob('nope' as 'iid', 1, COMMIT, scale)).toThrow(/kind/);
  });
});
