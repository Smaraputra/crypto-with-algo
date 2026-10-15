// @vitest-environment node
/**
 * Final review m7: the runner-to-stage seam. Each container command the runner emits (RUNNER_ARGV, which
 * rv-revalidation-run.test.ts pins against the runner) runs here through the real CLI with tsx, with the container
 * paths /app/out and /app/ds mapped to temporary directories and each output moved into place as the runner does:
 * - resolve and inputs on a fixture export of the full header span, Binance REST answered by a stand-in server on
 *   127.0.0.1 through BINANCE_FUTURES_API_URL, the base URL the CLI already reads (src/lib/binance-futures.ts)
 * - real, the three merges, dsr and verdict on the panel inputs built, with made-up shards at its provenance
 * - one real shard on a small panel, merged with seven made-up siblings
 * - check-calibration on 130 made-up outputs, the job lists, and calibrate with a name that is not a job
 * The records the runner reads with top_field are read here with the runner's own top_field.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSeededRandom } from '@/lib/stats/seeded-random';
import { datasetHashOf, sha256File, writeJsonlGz, type DatasetManifest, type FundingRow, type ManifestFile, type PerpCandleRow } from '../research/dataset-format';
import { CALIBRATION_UNIVERSES, RV_SEEDS, RV_WF_GEOMETRY, insampleShard, type NullLine } from '../research/rv-mcpt';
import { RV_SPAN, RV_SYMBOLS } from '../research/rv-panel';
import { jobLines } from '../research/rv-judge';
import { calibrationJobs, shardJobs, stageSeed, writeInputs, type CalibrationOutput, type Provenance, type ShardStage } from '../research/rv-stages';
import { syntheticPanel } from '../research/rv-synthetic';
import { RUNNER_ARGV, RUNNER_INPUTS_FILES } from './__fixtures__/rv-runner-argv';

const ROOT = join(__dirname, '../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const RUNBOOK = readFileSync(join(__dirname, 'rv-revalidation-run.sh'), 'utf8');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const H = 3_600_000;
const STAGES: ShardStage[] = ['is-mcpt', 'wf-mcpt', 'block'];
/** SOLUSDT switches from stated 8h to stated 2h settlements here, so 02:00 is flagged and REST must clear it. */
const SWITCH = RV_SPAN.from + 48 * H;
const FLAG_T = SWITCH + 2 * H;

// ------------------------------------------------------------------------------------------------ fixture export

/** Every 1h bar of the header span for one symbol, a seeded walk. */
function hourly(seed: number): PerpCandleRow[] {
  const random = createSeededRandom(seed);
  const rows: PerpCandleRow[] = [];
  let price = 100 + seed;
  for (let t = RV_SPAN.from; t <= RV_SPAN.to; t += H) {
    const o = price;
    const c = o * (1 + (random() - 0.5) * 0.01);
    const v = 100 + random() * 900;
    rows.push({ t, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v, qv: v * o, n: 50, tbv: v * (0.3 + random() * 0.4) });
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
      v: g.reduce((a, r) => a + r.v, 0),
      qv: g.reduce((a, r) => a + r.qv, 0),
      n: 200,
      tbv: g.reduce((a, r) => a + (r.tbv as number), 0),
    });
  }
  return out;
}

function settlements(from: number, to: number, hours: number, seed: number): FundingRow[] {
  const out: FundingRow[] = [];
  for (let t = from; t <= to; t += hours * H) out.push({ t, rate: 0.0001 * Math.sin(t / 1e9 + seed), intervalHours: hours });
  return out;
}

/** A complete export of the header span: 1h and 4h perp klines and funding for the ten symbols. */
async function writeExport(dir: string): Promise<{ hash: string; funding: Record<string, FundingRow[]> }> {
  const files: ManifestFile[] = [];
  const funding: Record<string, FundingRow[]> = {};
  const put = async (rel: string, kind: ManifestFile['kind'], symbol: string, interval: string, rows: { t: number }[]) => {
    await writeJsonlGz(join(dir, rel), rows);
    files.push({ path: rel, kind, symbol, interval, rowCount: rows.length, startMs: rows[0].t, endMs: rows[rows.length - 1].t, sha256: await sha256File(join(dir, rel)) });
  };
  for (const [i, symbol] of RV_SYMBOLS.entries()) {
    const rows1h = hourly(700 + i);
    funding[symbol] =
      symbol === 'SOLUSDT' ? [...settlements(RV_SPAN.from + 8 * H, SWITCH, 8, i), ...settlements(SWITCH + 4 * H, RV_SPAN.to, 2, i)] : settlements(RV_SPAN.from + 8 * H, RV_SPAN.to, 8, i);
    await put(`perp/${symbol}/4h.jsonl.gz`, 'perp', symbol, '4h', fourHourly(rows1h));
    await put(`perp/${symbol}/1h.jsonl.gz`, 'perp', symbol, '1h', rows1h);
    await put(`funding/${symbol}/settlements.jsonl.gz`, 'funding', symbol, 'settlements', funding[symbol]);
  }
  const manifest: DatasetManifest = {
    version: 1,
    generatedAt: new Date(RV_SPAN.from).toISOString(),
    commit: 'fixture',
    lockboxStart: new Date(Date.UTC(2026, 6, 1)).toISOString(),
    symbols: [...RV_SYMBOLS],
    intervals: ['1h', '4h'],
    files,
    datasetHash: datasetHashOf(files),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { hash: manifest.datasetHash, funding };
}

/** Binance's /fapi/v1/fundingRate, answered from the export's own settlements. */
function restStandIn(funding: Record<string, FundingRow[]>): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    calls.push(`${u.pathname} ${u.searchParams.get('symbol')}`);
    if (u.pathname !== '/fapi/v1/fundingRate') {
      res.writeHead(404).end();
      return;
    }
    const symbol = u.searchParams.get('symbol') ?? '';
    const from = Number(u.searchParams.get('startTime'));
    const to = Number(u.searchParams.get('endTime'));
    const limit = Number(u.searchParams.get('limit'));
    const rows = (funding[symbol] ?? []).filter((r) => r.t >= from && r.t <= to).slice(0, limit);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rows.map((r) => ({ symbol, fundingTime: r.t, fundingRate: String(r.rate), markPrice: '100' }))));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, calls });
    })
  );
}

// ------------------------------------------------------------------------------------------------ made-up stage outputs

/** A shard file of a stage as rv-stages writes it, with made-up statistics. */
function shardText(stage: ShardStage, name: string, mFrom: number, mTo: number, provenance: Provenance): string {
  const seedOf = stageSeed(stage);
  const lines: NullLine[] = [];
  for (let m = mFrom; m <= mTo; m++) lines.push(stage === 'wf-mcpt' ? { m, seed: seedOf(m), best: -1, cells: [11] } : { m, seed: seedOf(m), best: -1, perCell: Array(12).fill(-1) });
  return [{ kind: 'header', stage, name, mFrom, mTo, M: 1000, provenance }, ...lines].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** 130 calibration outputs at the header scale that pass: uniform driftless p-values, the planted edge found. */
function calibrationOutputs(): CalibrationOutput[] {
  return calibrationJobs().map(({ kind, k }) => {
    const spec = CALIBRATION_UNIVERSES[kind];
    const seed = spec.seed(k);
    const p = kind === 'planted' || kind === 'carry' ? 1 / (spec.M + 1) : Math.ceil(((k - 0.5) / spec.count) * (spec.M + 1)) / (spec.M + 1);
    const above = Math.round(p * (spec.M + 1)) - 1;
    const nulls = Array.from({ length: spec.M }, (_, i) => ({ m: i + 1, seed: RV_SEEDS.inner(seed, i + 1), best: i < above ? 1 : -1 }));
    return {
      stage: 'calibrate' as const,
      kind,
      k,
      seed,
      bars: 3000,
      geometry: RV_WF_GEOMETRY,
      M: spec.M,
      gitCommit: COMMIT,
      is: { real: 0, perCell: Array(12).fill(0), nulls },
      wf: { real: 0, cells: [0], nulls },
      timing: { prepareMs: 100 + k, oneCellMs: 20, twelveCellsMs: 300, isPermutationMs: 320, wfPermutationMs: 400 + k / 3 },
    };
  });
}

// ------------------------------------------------------------------------------------------------ running the CLIs

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Maps the container paths of a runner command to this run's directories. */
const onHost = (argv: readonly string[], out: string, ds: string) =>
  argv.map((a) => (a === '/app/out' || a.startsWith('/app/out/') ? out + a.slice('/app/out'.length) : a === '/app/ds' || a.startsWith('/app/ds/') ? ds + a.slice('/app/ds'.length) : a));

/** Runs a runner command (npx tsx <script> ...) with this checkout's tsx, asynchronously, so the stand-in can answer. */
function run(argv: readonly string[], dirs: { out: string; ds: string }, env: Record<string, string>): Promise<Ran> {
  expect(argv.slice(0, 2)).toEqual(['npx', 'tsx']);
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, onHost(argv, dirs.out, dirs.ds).slice(2), { cwd: ROOT, env: { ...process.env, GIT_COMMIT: COMMIT, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** The runner's own top_field, run on a record. */
function topField(key: string, file: string): string {
  const fn = /^top_field\(\) \{.*\}$/m.exec(RUNBOOK);
  if (!fn) throw new Error('no top_field in the runbook');
  return spawnSync('bash', ['-c', `${fn[0]}\ntop_field "$1" "$2"`, 'top_field', key, file], { encoding: 'utf8' }).stdout.trim();
}

/** The runner's settle: a finished output moves from part/ into place. */
const settle = (out: string, part: string, final: string) => renameSync(join(out, 'part', part), join(out, final));

describe('the runner\'s commands through the real CLIs (final review m7)', { timeout: 120_000 }, () => {
  let root: string;
  let ds: string;
  let out: string;
  let small: string;
  let hash: string;
  let rest: Awaited<ReturnType<typeof restStandIn>>;
  let env: Record<string, string>;
  let provenance: Provenance;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'rv-cli-'));
    ds = join(root, 'rv2-ds');
    out = join(root, 'rv2-out');
    small = join(root, 'small-out');
    for (const d of [ds, join(out, 'part'), join(out, 'inputs'), join(small, 'part'), join(small, 'shards/is-mcpt')]) mkdirSync(d, { recursive: true });
    const exported = await writeExport(ds);
    hash = exported.hash;
    rest = await restStandIn(exported.funding);
    env = { BINANCE_FUTURES_API_URL: rest.url };
  }, 120_000);

  afterAll(() => {
    rest?.server.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('resolve drafts the flagged settlement from REST, writes the files the runner names, and records them for top_field', async () => {
    const r = await run(RUNNER_ARGV.resolve(hash), { out, ds }, env);
    expect(r.status, r.stderr).toBe(0);
    expect(rest.calls.filter((c) => c.endsWith(' SOLUSDT')).length).toBeGreaterThan(0);
    expect(readdirSync(join(out, 'inputs')).sort()).toEqual([...RUNNER_INPUTS_FILES.resolve].sort());
    for (const f of RUNNER_INPUTS_FILES.resolve) expect(RUNBOOK).toContain(`$INPUTS/${f}`);
    expect(JSON.parse(readFileSync(join(out, 'inputs/resolutions.json'), 'utf8')).resolutions).toEqual([
      { symbol: 'SOLUSDT', t: new Date(FLAG_T).toISOString(), verdict: 'no-event', restBefore: new Date(SWITCH).toISOString(), restAfter: new Date(SWITCH + 4 * H).toISOString() },
    ]);
    const record = join(out, 'inputs/resolve.json');
    expect(topField('gitCommit', record)).toBe(`"${COMMIT}"`);
    expect(topField('manifestHash', record)).toBe(`"${hash}"`);
    expect(topField('sha256', record)).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it('inputs verifies the reviewed file against REST and builds the full-span panel, recorded for top_field', async () => {
    const r = await run(RUNNER_ARGV.inputs(hash), { out, ds }, env);
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(join(out, 'inputs')).sort()).toEqual([...RUNNER_INPUTS_FILES.resolve, ...RUNNER_INPUTS_FILES.inputs].sort());
    for (const f of RUNNER_INPUTS_FILES.inputs) expect(RUNBOOK).toContain(`$INPUTS/${f}`);
    const record = join(out, 'inputs/inputs.json');
    expect(topField('gitCommit', record)).toBe(`"${COMMIT}"`);
    expect(topField('manifestHash', record)).toBe(`"${hash}"`);
    const rec = JSON.parse(readFileSync(record, 'utf8'));
    expect(rec.bars).toBe(5240);
    provenance = { manifestHash: rec.manifestHash, panelSha256: rec.panelSha256, gitCommit: COMMIT };
  });

  it('real writes its output where the runner settles it from', async () => {
    const r = await run(RUNNER_ARGV.real(hash), { out, ds }, env);
    expect(r.status, r.stderr).toBe(0);
    settle(out, 'real.json', 'real.json');
    expect(JSON.parse(readFileSync(join(out, 'real.json'), 'utf8')).provenance).toEqual(provenance);
  });

  it('the job lists are the ones the runner parses', async () => {
    for (const stage of ['is-mcpt', 'calibrate'] as const) {
      const r = await run(RUNNER_ARGV.jobs(stage), { out, ds }, env);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(`${jobLines(stage).join('\n')}\n`);
    }
  });

  it('one shard runs by its job name and merges with its stage\'s other shards', async () => {
    const panel = syntheticPanel({ bars: 120, symbols: 10, mode: 'iid', strength: 0, seed: 5 });
    const rec = writeInputs(join(small, 'inputs'), {
      panel,
      firstHour: { open: panel.open, high: panel.high, low: panel.low, close: panel.close },
      manifestHash: hash,
      resolutions: { sha256: 'd'.repeat(64), entries: 0, flags: [] },
      gitCommit: COMMIT,
      span: { from: 0, to: 1 },
    });
    const smallProv = { manifestHash: hash, panelSha256: rec.panelSha256, gitCommit: COMMIT };
    const [first, ...others] = shardJobs('is-mcpt');
    const r = await run(RUNNER_ARGV.shard('is-mcpt', first.name, hash), { out: small, ds }, env);
    expect(r.status, r.stderr).toBe(0);
    settle(small, `${first.name}.jsonl`, `shards/is-mcpt/${first.name}.jsonl`);
    for (const j of others) writeFileSync(join(small, 'shards/is-mcpt', `${j.name}.jsonl`), shardText('is-mcpt', j.name, j.mFrom, j.mTo, smallProv));
    const m = await run(RUNNER_ARGV.merge('is-mcpt', hash), { out: small, ds }, env);
    expect(m.status, m.stderr).toBe(0);
    const merged = JSON.parse(readFileSync(join(small, 'part/is-mcpt.json'), 'utf8'));
    expect(merged.nulls.slice(0, 125)).toEqual(insampleShard(panel, 1, 125, RV_SEEDS.is).map((l) => l.best));
  });

  it('merge, check-calibration, dsr and verdict run on the runner\'s layout', async () => {
    for (const stage of STAGES) {
      mkdirSync(join(out, 'shards', stage), { recursive: true });
      for (const j of shardJobs(stage)) writeFileSync(join(out, 'shards', stage, `${j.name}.jsonl`), shardText(stage, j.name, j.mFrom, j.mTo, provenance));
      const m = await run(RUNNER_ARGV.merge(stage, hash), { out, ds }, env);
      expect(m.status, m.stderr).toBe(0);
      settle(out, `${stage}.json`, `${stage}.json`);
    }
    mkdirSync(join(out, 'calibration'));
    for (const o of calibrationOutputs()) writeFileSync(join(out, 'calibration', `cal-${o.kind}-${String(o.k).padStart(3, '0')}.json`), JSON.stringify(o));
    const c = await run(RUNNER_ARGV.checkCalibration(), { out, ds }, env);
    expect(c.status, c.stderr).toBe(0);
    expect(c.stdout).toMatch(/CALIBRATION PASS/);
    settle(out, 'calibration.json', 'calibration.json');
    expect(topField('gitCommit', join(out, 'calibration.json'))).toBe(`"${COMMIT}"`);
    expect(topField('pass', join(out, 'calibration.json'))).toBe('true');

    const d = await run(RUNNER_ARGV.dsr(hash), { out, ds }, env);
    expect(d.status, d.stderr).toBe(0);
    const line = d.stdout.trim().split('\n').pop()!;
    expect(line).toMatch(/^G3: DSR \d\.\d{4} at N = 672 .*, T \d+\. Reported: N = 26: \d\.\d{4}, N = 2161: \d\.\d{4}$/);
    expect(line).not.toContain(';');

    const v = await run(RUNNER_ARGV.verdict(hash), { out, ds }, env);
    expect(v.status, v.stderr).toBe(0);
    expect(v.stdout).toMatch(/^VERDICT (PASS|FAIL)$/m);
    settle(out, 'verdict.json', 'verdict.json');
    const verdict = JSON.parse(readFileSync(join(out, 'verdict.json'), 'utf8'));
    expect(verdict.provenance).toEqual(provenance);
    expect(verdict.gates.G1.p).toBe(1 / 1001);
  });

  it('calibrate parses its flags: a name that is not a job is refused by name', async () => {
    const r = await run(RUNNER_ARGV.calibrate('cal-bogus-001'), { out, ds }, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSE: cal-bogus-001 is not a listed calibration job/);
  });
});
