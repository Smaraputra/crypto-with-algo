// @vitest-environment node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCK_M, IS_M, WF_M } from '../research/rv-mcpt';
import { RV_SPAN, RV_SYMBOLS } from '../research/rv-panel';
import { jobLines } from '../research/rv-judge';
import { calibrationJobs, shardJobs, type ShardStage } from '../research/rv-stages';
import { RUNNER_ARGV } from './__fixtures__/rv-runner-argv';

const RUNBOOK = join(__dirname, 'rv-revalidation-run.sh');
const STUB = join(__dirname, '__fixtures__', 'rv-docker-stub.sh');
const HEADER = readFileSync(join(__dirname, '../research/rv-revalidation.ts'), 'utf8');
const runbook = () => readFileSync(RUNBOOK, 'utf8');

/** The value of a top-level `NAME=value` or `NAME='value'` assignment in the runbook. */
function assigned(name: string): string {
  const m = new RegExp(`^${name}=(.*)$`, 'm').exec(runbook());
  if (!m) throw new Error(`${name} is not assigned in the runbook`);
  return m[1].replace(/^'(.*)'$/, '$1');
}

const DATASET = 'd'.repeat(64);
const REST_URL = 'https://fapi.example.test';
const SHARD_STAGES: ShardStage[] = ['is-mcpt', 'wf-mcpt', 'block'];

interface World {
  home: string;
  build: string;
  out: string;
  ds: string;
  envFile: string;
  commit: string;
}

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

/** A $HOME holding a clean checkout with one commit, a stub docker whose image carries that commit, and an env file. */
function world(): World {
  const home = mkdtempSync(join(tmpdir(), 'rv2-run-'));
  homes.push(home);
  const build = join(home, 'crypto-archive-build');
  mkdirSync(join(build, 'scripts/research'), { recursive: true });
  git(build, 'init', '-q');
  git(build, 'config', 'user.email', 't@t');
  git(build, 'config', 'user.name', 't');
  writeFileSync(join(build, 'scripts/research/rv-revalidation.ts'), 'export {};\n');
  git(build, 'add', '-A');
  git(build, 'commit', '-qm', 'study');
  const commit = git(build, 'rev-parse', 'HEAD');
  mkdirSync(join(home, 'bin'));
  copyFileSync(STUB, join(home, 'bin/docker'));
  chmodSync(join(home, 'bin/docker'), 0o755);
  mkdirSync(join(home, 'stub'));
  writeFileSync(join(home, 'stub/label'), `${commit}\n`);
  for (const stage of [...SHARD_STAGES, 'calibrate'] as const) {
    writeFileSync(join(home, `stub/jobs-${stage}.txt`), `${jobLines(stage).join('\n')}\n`);
  }
  const envFile = join(home, 'crypto.env');
  writeFileSync(envFile, `MONGODB_URI=mongodb://user:secret@mongo/db\nBINANCE_FUTURES_API_URL="${REST_URL}"\n`);
  return { home, build, out: join(home, 'rv2-out'), ds: join(home, 'rv2-ds'), envFile, commit };
}

/** A new commit in the checkout, labelled on the image as a rebuild would. */
function commitMore(w: World, file: string): string {
  writeFileSync(join(w.build, file), `${file}\n`);
  git(w.build, 'add', '-A');
  git(w.build, 'commit', '-qm', file);
  const c = git(w.build, 'rev-parse', 'HEAD');
  writeFileSync(join(w.home, 'stub/label'), `${c}\n`);
  return c;
}

interface RunCall {
  args: string[];
  name: string;
  /** The docker flags before the image. */
  flags: string[];
  image: string;
  /** The command after the image. */
  cmd: string[];
  network: string[];
  mounts: string[];
  env: string[];
}

function valuesOf(flags: string[], flag: string): string[] {
  const out: string[] = [];
  flags.forEach((f, i) => {
    if (f === flag) out.push(flags[i + 1]);
  });
  return out;
}

function parseRun(args: string[]): RunCall {
  const at = args.findIndex((a) => a.startsWith('sha256:') || a === 'crypto-ops:rv2');
  const flags = args.slice(1, at);
  return {
    args,
    name: valuesOf(flags, '--name')[0],
    flags,
    image: args[at],
    cmd: args.slice(at + 1),
    network: valuesOf(flags, '--network'),
    mounts: valuesOf(flags, '-v'),
    env: valuesOf(flags, '-e'),
  };
}

function dockerLog(w: World): string[][] {
  const file = join(w.home, 'docker.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.split('\x1f').slice(0, -1));
}

/** Runs one stage with the stub docker first on PATH and returns its status, output and the docker calls it made. */
function stage(w: World, name: string, env: Record<string, string> = {}) {
  const before = dockerLog(w).length;
  const r = spawnSync('bash', [RUNBOOK, name], {
    env: { ...process.env, HOME: w.home, PATH: `${w.home}/bin:${process.env.PATH}`, RV2_ENV_FILE: w.envFile, ...env },
    encoding: 'utf8',
  });
  const calls = dockerLog(w).slice(before);
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls, runs: calls.filter((c) => c[0] === 'run').map(parseRun) };
}

/** The most containers alive at once, from the stub's start and end events (optionally only names with a prefix). */
function maxAlive(w: World, prefix = ''): number {
  let alive = 0;
  let max = 0;
  for (const line of readFileSync(join(w.home, 'events.log'), 'utf8').split('\n')) {
    const [what, name] = line.split(' ');
    if (!name?.startsWith(prefix)) continue;
    alive += what === 'start' ? 1 : -1;
    max = Math.max(max, alive);
  }
  return max;
}

const read = (path: string) => readFileSync(path, 'utf8');
const sorted = (xs: string[]) => [...xs].sort();

/** The state calibrate leaves after a PASS, written directly so a refusal test need not run the 130 universes. */
function calibrated(w: World, commit = w.commit): void {
  calibrationOutputs(w);
  writeFileSync(join(w.out, 'run-commit'), `${commit}\n`);
  writeFileSync(join(w.out, 'run-image'), 'sha256:stub\n');
  writeFileSync(join(w.out, 'calibration.json'), `{\n  "gitCommit": "${commit}",\n  "pass": true\n}\n`);
  writeFileSync(join(w.out, 'calibration.pass'), `${commit}\n`);
}

/** The 130 calibration outputs, so a calibrate call keeps them all and goes straight to check-calibration. */
function calibrationOutputs(w: World): void {
  mkdirSync(join(w.out, 'calibration'), { recursive: true });
  for (const j of calibrationJobs()) writeFileSync(join(w.out, 'calibration', `${j.name}.json`), '{}\n');
}

/** The state export leaves. */
function exported(w: World): void {
  mkdirSync(w.ds, { recursive: true });
  writeFileSync(join(w.ds, 'manifest.json'), `{"datasetHash":"${DATASET}"}\n`);
  writeFileSync(join(w.out, 'manifest-hash'), `${DATASET}\n`);
}

/** The state resolve leaves, at this commit unless another is given. */
function resolved(w: World, commit = w.commit): void {
  mkdirSync(join(w.out, 'inputs'), { recursive: true });
  writeFileSync(join(w.out, 'inputs/resolutions.json'), '[]\n');
  writeFileSync(join(w.out, 'inputs/resolve.json'), `{\n  "manifestHash": "${DATASET}",\n  "gitCommit": "${commit}"\n}\n`);
}

/** The state inputs leaves, at this commit unless another is given. */
function recordedPanel(w: World, commit = w.commit): void {
  resolved(w);
  writeFileSync(join(w.out, 'inputs/panel.json.gz'), 'panel');
  writeFileSync(join(w.out, 'inputs/inputs.json'), `{\n  "manifestHash": "${DATASET}",\n  "gitCommit": "${commit}"\n}\n`);
}

/** The stage outputs up to and including `upTo`, in the stage order real, is-mcpt, wf-mcpt, block. */
function stagesDone(w: World, upTo: 'real' | ShardStage): void {
  const order = ['real', 'is-mcpt', 'wf-mcpt', 'block'];
  for (const s of order.slice(0, order.indexOf(upTo) + 1)) writeFileSync(join(w.out, `${s}.json`), '{}\n');
}

/** The last line of stages.log. */
function lastStage(w: World): { stage: string; exit: number; commit: string } {
  return JSON.parse(read(join(w.out, 'stages.log')).trim().split('\n').pop()!) as { stage: string; exit: number; commit: string };
}

/** Docker calls other than the lock's container check and the image checks. */
const containerCalls = (calls: string[][]) => calls.filter((c) => c[0] !== 'ps' && c[0] !== 'image');
const runsOf = (r: { runs: RunCall[] }, mode: string) => r.runs.filter((c) => c.cmd[3] === mode);

describe('rv-revalidation-run.sh', () => {
  it('parses', () => {
    expect(() => execFileSync('bash', ['-n', RUNBOOK])).not.toThrow();
  });

  it('parses the whole dispatch as one block before a stage runs, so a checkout change mid-stage cannot alter it (review M5)', () => {
    expect(runbook()).toMatch(/\n\{\n(?:.*\n)*?\s*"stage_\$\{STAGE\/\/-\/_\}"\n(?:.*\n)*?\s*exit "\$RC"\n\}\n$/);
  });

  it('pins the header DATA export: universe, span, kinds, series and intervals', () => {
    expect(assigned('SYMBOLS')).toBe(RV_SYMBOLS.join(','));
    expect(new Date(assigned('DS_START')).getTime()).toBe(RV_SPAN.from);
    expect(new Date(assigned('DS_END')).getTime()).toBe(RV_SPAN.to);
    expect(HEADER).toContain(`\`--datasets ${assigned('EXPORT_DATASETS')} --perp-series ${assigned('EXPORT_PERP_SERIES')} --intervals ${assigned('EXPORT_INTERVALS')}\``);
    expect(HEADER).toContain(`start ${assigned('DS_START')}`);
    expect(HEADER).toContain(`end ${assigned('DS_END')}`);
  });

  it('pins the paths: a fresh $HOME/rv2-ds, the VPS env file, and its own image and label', () => {
    expect(assigned('DS')).toBe('$HOME/rv2-ds');
    expect(assigned('OUT')).toBe('$HOME/rv2-out');
    expect(assigned('ENV_FILE')).toBe('${RV2_ENV_FILE:-/opt/sites/crypto/.env}');
    expect(assigned('IMG')).toBe('crypto-ops:rv2');
    expect(assigned('LABEL')).toBe('rv2.gitCommit');
  });

  it('pins M and the calibration job count to the machinery', () => {
    expect(Number(assigned('M'))).toBe(IS_M);
    expect([IS_M, WF_M, BLOCK_M]).toEqual([1000, 1000, 1000]);
    expect(Number(assigned('CAL_JOBS'))).toBe(calibrationJobs().length);
    expect(calibrationJobs()).toHaveLength(130);
  });
});

describe('rv-revalidation-run.sh, every stage in order against a stub docker', () => {
  it('runs build to verdict with the pinned image, the flags and the file layout of each stage', () => {
    const w = world();
    const H = DATASET;

    // build: the clean HEAD, labelled
    let r = stage(w, 'build');
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toContainEqual(['build', '--target', 'seeder', '--label', `rv2.gitCommit=${w.commit}`, '-t', 'crypto-ops:rv2', w.build]);
    expect(r.runs).toHaveLength(0);

    // calibrate: pins the run, 130 synthetic universes, then check-calibration, all without network or dataset
    r = stage(w, 'calibrate');
    expect(r.status, r.out).toBe(0);
    const calibration = r.runs;
    expect(read(join(w.out, 'run-commit')).trim()).toBe(w.commit);
    expect(read(join(w.out, 'run-image')).trim()).toBe('sha256:stub');
    const calNames = calibrationJobs().map((j) => j.name);
    const calRuns = calibration.filter((c) => c.cmd[3] === 'calibrate');
    expect(sorted(calRuns.map((c) => c.cmd.join(' ')))).toEqual(sorted(calNames.map((n) => RUNNER_ARGV.calibrate(n).join(' '))));
    expect(sorted(readdirSync(join(w.out, 'calibration')))).toEqual(sorted(calNames.map((n) => `${n}.json`)));
    const check = calibration.filter((c) => c.cmd[3] === 'check-calibration');
    expect(check.map((c) => c.cmd)).toEqual([RUNNER_ARGV.checkCalibration()]);
    expect(read(join(w.out, 'calibration.pass')).trim()).toBe(w.commit);
    expect(read(join(w.out, 'calibration.json'))).toContain(`"gitCommit": "${w.commit}"`);
    expect(calibration.every((c) => c.mounts.every((m) => !m.includes(':/app/ds')))).toBe(true);
    expect(calibration.filter((c) => c.cmd[3] === 'jobs').map((c) => c.cmd)).toEqual([RUNNER_ARGV.jobs('calibrate')]);
    expect(maxAlive(w, 'rv2-calibrate-cal-')).toBeLessThanOrEqual(2);

    // export: the header's command, on the internal network with the env file, into a fresh $HOME/rv2-ds
    r = stage(w, 'export');
    expect(r.status, r.out).toBe(0);
    expect(r.runs).toHaveLength(1);
    const ex = r.runs[0];
    expect(ex.network).toEqual(['crypto_crypto-internal']);
    expect(valuesOf(ex.flags, '--env-file')).toEqual([w.envFile]);
    expect(ex.mounts).toEqual([`${w.ds}:/app/out`]);
    expect(ex.cmd).toEqual([
      'npx', 'tsx', 'scripts/research/export-dataset.ts', '--symbols', RV_SYMBOLS.join(','), '--datasets', 'perp,funding',
      '--perp-series', 'klines', '--intervals', '1h,4h', '--start', '2022-01-01T00:00:00Z', '--end', '2026-10-13T23:59:59.999Z',
      '--out', '/app/out',
    ]);
    expect(read(join(w.out, 'manifest-hash')).trim()).toBe(H);

    // resolve: REST on the bridge network with the env file's base URL only, prints the entries and stops
    r = stage(w, 'resolve');
    expect(r.status, r.out).toBe(0);
    expect(r.runs).toHaveLength(1);
    const res = r.runs[0];
    expect(res.network).toEqual(['bridge']);
    expect(res.env).toContain(`BINANCE_FUTURES_API_URL=${REST_URL}`);
    expect(valuesOf(res.flags, '--env-file')).toEqual([]);
    expect(res.mounts).toEqual([`${w.ds}:/app/ds:ro`, `${w.out}:/app/out`]);
    expect(res.cmd).toEqual(RUNNER_ARGV.resolve(H));
    expect(r.out).toContain('"symbol":"SOLUSDT"');
    expect(r.out).toMatch(/CONTROLLER CHECKPOINT/);
    expect(r.out).not.toContain('mongodb://');
    expect(existsSync(join(w.out, 'inputs/inputs.json'))).toBe(false);

    // inputs: the reviewed file, verified against REST, same network rule
    r = stage(w, 'inputs');
    expect(r.status, r.out).toBe(0);
    expect(r.runs).toHaveLength(1);
    const inp = r.runs[0];
    expect(inp.network).toEqual(['bridge']);
    expect(inp.env).toContain(`BINANCE_FUTURES_API_URL=${REST_URL}`);
    expect(inp.cmd).toEqual(RUNNER_ARGV.inputs(H));

    // real
    r = stage(w, 'real');
    expect(r.status, r.out).toBe(0);
    expect(r.runs.map((c) => c.cmd)).toEqual([RUNNER_ARGV.real(H)]);
    expect(existsSync(join(w.out, 'real.json'))).toBe(true);

    // the three permutation stages: the judge's jobs, two containers at once, one directory per stage, then merge
    for (const s of SHARD_STAGES) {
      rmSync(join(w.home, 'events.log'));
      r = stage(w, s, { STUB_SLEEP: '0.15' });
      expect(r.status, r.out).toBe(0);
      const names = shardJobs(s).map((j) => j.name);
      expect(names).toHaveLength(8);
      const shards = r.runs.filter((c) => c.cmd[3] === 'shard');
      expect(sorted(shards.map((c) => c.cmd.join(' ')))).toEqual(sorted(names.map((n) => RUNNER_ARGV.shard(s, n, H).join(' '))));
      expect(r.runs.filter((c) => c.cmd[3] === 'jobs').map((c) => c.cmd)).toEqual([RUNNER_ARGV.jobs(s)]);
      expect(sorted(readdirSync(join(w.out, 'shards', s)))).toEqual(names.map((n) => `${n}.jsonl`));
      expect(maxAlive(w)).toBe(2);
      const merge = r.runs.filter((c) => c.cmd[3] === 'merge');
      expect(merge.map((c) => c.cmd)).toEqual([RUNNER_ARGV.merge(s, H)]);
      expect(existsSync(join(w.out, `${s}.json`))).toBe(true);
    }

    // verdict: dsr, then the verdict with the calibration record and the 130 outputs
    r = stage(w, 'verdict');
    expect(r.status, r.out).toBe(0);
    // every container command of the run is one rv-revalidation-cli.test.ts runs through the real CLI (final review m7)
    expect(r.runs.map((c) => c.cmd)).toEqual([RUNNER_ARGV.dsr(H), RUNNER_ARGV.verdict(H)]);
    expect(r.out).toContain('VERDICT FAIL');
    expect(existsSync(join(w.out, 'verdict.json'))).toBe(true);

    // every container, every stage
    const all = dockerLog(w).filter((c) => c[0] === 'run').map(parseRun);
    // calibrate 1 + 130 + 1, export, resolve, inputs and real 1 each, three shard stages 1 + 8 + 1 each, verdict 2
    expect(all.length).toBe(132 + 4 + 3 * 10 + 2);
    for (const c of all) {
      expect(c.image, c.name).toBe('sha256:stub');
      expect(c.flags.slice(0, 2), c.name).toEqual(['--name', c.name]);
      expect(c.flags, c.name).toEqual(expect.arrayContaining(['--rm', '--cpu-shares', '256', '--memory', '3g']));
      expect(valuesOf(c.flags, '--cpu-shares'), c.name).toEqual(['256']);
      expect(valuesOf(c.flags, '--memory'), c.name).toEqual(['3g']);
      expect(c.env, c.name).toContain(`GIT_COMMIT=${w.commit}`);
      const isExport = c.cmd[2] === 'scripts/research/export-dataset.ts';
      const isRest = c.cmd[2] === 'scripts/research/rv-stages.ts' && (c.cmd[3] === 'resolve' || c.cmd[3] === 'inputs');
      // the exact network flag of every container
      expect(valuesOf(c.flags, '--network'), c.name).toEqual([isExport ? 'crypto_crypto-internal' : isRest ? 'bridge' : 'none']);
      expect(valuesOf(c.flags, '--env-file'), c.name).toEqual(isExport ? [w.envFile] : []);
      expect(c.env.filter((e) => e.startsWith('BINANCE_FUTURES_API_URL=')), c.name).toEqual(isRest ? [`BINANCE_FUTURES_API_URL=${REST_URL}`] : []);
      // the exact mounts (source, target, read-only or not): the image is the code, so nothing of the checkout is
      // mounted, the dataset is read-only wherever it is read, and only export writes it
      const mounts = isExport ? [`${w.ds}:/app/out`] : isRest ? [`${w.ds}:/app/ds:ro`, `${w.out}:/app/out`] : [`${w.out}:/app/out`];
      expect(c.mounts, c.name).toEqual(mounts);
    }
    // every stage but build checked the image label first
    const labelChecks = dockerLog(w).filter((c) => c[0] === 'image' && c.join(' ').includes('Labels'));
    expect(labelChecks.length).toBeGreaterThanOrEqual(9);
    const log = read(join(w.out, 'stages.log')).trim().split('\n').map((l) => JSON.parse(l) as { stage: string; exit: number; commit: string });
    expect(log.map((l) => [l.stage, l.exit])).toEqual(
      ['build', 'calibrate', 'export', 'resolve', 'inputs', 'real', 'is-mcpt', 'wf-mcpt', 'block', 'verdict'].map((s) => [s, 0])
    );
    expect(log.every((l) => l.commit === w.commit)).toBe(true);
  }, 120_000);
});

describe('rv-revalidation-run.sh refusals', { timeout: 30_000 }, () => {
  const noRun = (r: ReturnType<typeof stage>) => expect(r.runs, r.out).toHaveLength(0);

  it('export refuses before calibrate has pinned the run and recorded a PASS', () => {
    const w = world();
    const r = stage(w, 'export');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/calibrate/);
    noRun(r);
    expect(existsSync(w.ds)).toBe(false);
  });

  it('a failed calibration stops the study: exit 2, no PASS recorded, export refuses', () => {
    const w = world();
    const cal = stage(w, 'calibrate', { STUB_CAL: 'fail' });
    expect(cal.status).toBe(2);
    expect(cal.out).toMatch(/CALIBRATION FAIL/);
    expect(existsSync(join(w.out, 'calibration.pass'))).toBe(false);
    expect(read(join(w.out, 'calibration.json'))).toContain('"pass": false');
    const r = stage(w, 'export');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/calibration/i);
    noRun(r);
    expect(existsSync(w.ds)).toBe(false);
  }, 60_000);

  it('export refuses a PASS recorded at another commit, and a record that is not a PASS at this commit', () => {
    const w = world();
    calibrated(w);
    writeFileSync(join(w.out, 'calibration.pass'), `${'b'.repeat(40)}\n`);
    let r = stage(w, 'export');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/PASS/);
    noRun(r);
    calibrated(w);
    // a nested pass does not count: only the record's own top-level key does
    writeFileSync(join(w.out, 'calibration.json'), `{\n  "gitCommit": "${w.commit}",\n  "universes": [\n    {\n      "pass": true\n    }\n  ],\n  "pass": false\n}\n`);
    r = stage(w, 'export');
    expect(r.status).not.toBe(0);
    noRun(r);
  });

  it('export refuses an existing $HOME/rv2-ds (a dangling symlink included) or manifest-hash, even after a PASS', () => {
    const w = world();
    calibrated(w);
    mkdirSync(w.ds);
    let r = stage(w, 'export');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(w.ds);
    noRun(r);
    // nothing but the lock's container check reached docker
    expect(dockerLog(w).filter((c) => c[0] !== 'ps')).toHaveLength(0);
    expect(lastStage(w)).toMatchObject({ stage: 'export', exit: r.status });
    rmSync(w.ds, { recursive: true });
    symlinkSync(join(w.home, 'gone'), w.ds);
    r = stage(w, 'export');
    expect(r.status).not.toBe(0);
    // refused as an existing dataset, before the image is even looked at
    expect(r.out).toContain(`${w.ds} exists: the study's dataset is exported once`);
    expect(r.calls.filter((c) => c[0] === 'image')).toHaveLength(0);
    noRun(r);
    rmSync(w.ds);
    writeFileSync(join(w.out, 'manifest-hash'), `${DATASET}\n`);
    r = stage(w, 'export');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('manifest-hash');
    noRun(r);
    expect(existsSync(w.ds)).toBe(false);
  });

  it('inputs refuses without the record resolve writes, the controller checkpoint, and never runs resolve itself', () => {
    const w = world();
    calibrated(w);
    exported(w);
    let r = stage(w, 'inputs');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/resolve/);
    noRun(r);
    // a record from another commit is refused as well
    mkdirSync(join(w.out, 'inputs'), { recursive: true });
    writeFileSync(join(w.out, 'inputs/resolutions.json'), '[]\n');
    writeFileSync(join(w.out, 'inputs/resolve.json'), `{\n  "manifestHash": "${DATASET}",\n  "gitCommit": "${'b'.repeat(40)}"\n}\n`);
    r = stage(w, 'inputs');
    expect(r.status).not.toBe(0);
    noRun(r);
    // a record at this commit and dataset without the reviewed file it records
    writeFileSync(join(w.out, 'inputs/resolve.json'), `{\n  "manifestHash": "${DATASET}",\n  "gitCommit": "${w.commit}"\n}\n`);
    rmSync(join(w.out, 'inputs/resolutions.json'));
    r = stage(w, 'inputs');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/resolve/);
    noRun(r);
  });

  it('resolve and inputs refuse when the env file cannot be read, and state a missing base URL', () => {
    const w = world();
    calibrated(w);
    exported(w);
    let r = stage(w, 'resolve', { RV2_ENV_FILE: join(w.home, 'missing.env') });
    expect(r.status).not.toBe(0);
    noRun(r);
    writeFileSync(w.envFile, 'MONGODB_URI=mongodb://user:secret@mongo/db\n');
    r = stage(w, 'resolve');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/BINANCE_FUTURES_API_URL is not set/);
    expect(r.runs[0].env.some((e) => e.startsWith('BINANCE_FUTURES_API_URL'))).toBe(false);
    expect(r.out).not.toContain('mongodb://');
  });

  it('every stage after calibrate refuses a commit change, a Markdown-only commit included', () => {
    const w = world();
    calibrated(w);
    const later = commitMore(w, 'NOTES.md');
    for (const s of ['export', 'resolve', 'inputs', 'real', 'is-mcpt', 'wf-mcpt', 'block', 'verdict', 'build', 'calibrate']) {
      // export refuses an existing dataset before anything else, so the dataset appears only after export is tried
      if (s === 'resolve') exported(w);
      const r = stage(w, s);
      expect(r.status, s).not.toBe(0);
      expect(r.out, s).toContain(w.commit);
      expect(r.out, s).toContain(later);
      noRun(r);
    }
  });

  it('refuses an image labelled with another commit, and a checkout with untracked files', () => {
    const w = world();
    calibrated(w);
    writeFileSync(join(w.home, 'stub/label'), `${'b'.repeat(40)}\n`);
    let r = stage(w, 'real');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/labelled/);
    noRun(r);
    writeFileSync(join(w.home, 'stub/label'), `${w.commit}\n`);
    writeFileSync(join(w.build, 'stray.ts'), 'export {};\n');
    for (const s of ['build', 'calibrate', 'real']) {
      r = stage(w, s);
      expect(r.status, s).not.toBe(0);
      expect(r.out, s).toMatch(/uncommitted or untracked/);
      expect(r.calls.filter((c) => c[0] === 'build' || c[0] === 'run'), s).toHaveLength(0);
    }
  });

  it('a shard stage refuses before the inputs stage, and a job list that does not cover m = 1..M once', () => {
    const w = world();
    calibrated(w);
    exported(w);
    let r = stage(w, 'is-mcpt');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/inputs/);
    noRun(r);
    recordedPanel(w);
    stagesDone(w, 'real');
    const lines = jobLines('is-mcpt');
    writeFileSync(join(w.home, 'stub/jobs-is-mcpt.txt'), `${lines.filter((_, i) => i !== 3).join('\n')}\n`);
    r = stage(w, 'is-mcpt');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/is-mcpt-05/);
    expect(r.runs.filter((c) => c.cmd[3] === 'shard')).toHaveLength(0);
    // a list that stops short of M is refused as well
    writeFileSync(join(w.home, 'stub/jobs-is-mcpt.txt'), `${lines.slice(0, -1).join('\n')}\n`);
    r = stage(w, 'is-mcpt');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/m = 1\.\.875, the header's M is 1000/);
    expect(r.runs.filter((c) => c.cmd[3] === 'shard')).toHaveLength(0);
  });

  it('keeps a failed shard out of the stage directory and does not merge', () => {
    const w = world();
    calibrated(w);
    exported(w);
    recordedPanel(w);
    stagesDone(w, 'is-mcpt');
    let r = stage(w, 'wf-mcpt', { STUB_FAIL: 'rv2-wf-mcpt-wf-mcpt-03' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/wf-mcpt-03/);
    expect(readdirSync(join(w.out, 'shards/wf-mcpt'))).not.toContain('wf-mcpt-03.jsonl');
    expect(readdirSync(join(w.out, 'shards/wf-mcpt'))).toHaveLength(7);
    expect(r.runs.filter((c) => c.cmd[3] === 'merge')).toHaveLength(0);
    // a container that wrote its output and then failed is not trusted either
    r = stage(w, 'wf-mcpt', { STUB_FAIL_AFTER: 'rv2-wf-mcpt-wf-mcpt-03' });
    expect(r.status).not.toBe(0);
    expect(r.runs.filter((c) => c.cmd[3] === 'shard').map((c) => c.name)).toEqual(['rv2-wf-mcpt-wf-mcpt-03']);
    expect(readdirSync(join(w.out, 'shards/wf-mcpt'))).not.toContain('wf-mcpt-03.jsonl');
    expect(r.runs.filter((c) => c.cmd[3] === 'merge')).toHaveLength(0);
    // a rerun runs only the missing job, then merges
    r = stage(w, 'wf-mcpt');
    expect(r.status, r.out).toBe(0);
    expect(r.runs.filter((c) => c.cmd[3] === 'shard').map((c) => c.name)).toEqual(['rv2-wf-mcpt-wf-mcpt-03']);
    expect(r.runs.filter((c) => c.cmd[3] === 'merge')).toHaveLength(1);
  });

  it('verdict refuses without a calibration PASS at this commit', () => {
    const w = world();
    calibrated(w);
    exported(w);
    mkdirSync(join(w.out, 'inputs'), { recursive: true });
    writeFileSync(join(w.out, 'inputs/panel.json.gz'), 'panel');
    writeFileSync(join(w.out, 'inputs/inputs.json'), `{\n  "manifestHash": "${DATASET}",\n  "gitCommit": "${w.commit}"\n}\n`);
    for (const f of ['real.json', 'is-mcpt.json', 'wf-mcpt.json', 'block.json']) writeFileSync(join(w.out, f), '{}\n');
    rmSync(join(w.out, 'calibration.pass'));
    const r = stage(w, 'verdict');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/calibration/i);
    noRun(r);
  });

  it('runs one stage at a time: a held lock refuses a second stage without touching it', () => {
    const w = world();
    calibrated(w);
    mkdirSync(join(w.out, '.lock'), { recursive: true });
    writeFileSync(join(w.out, '.lock/pid'), '4242\n');
    const r = stage(w, 'real');
    expect(r.status).toBe(75);
    expect(r.out).toMatch(/4242/);
    expect(dockerLog(w)).toHaveLength(0);
    expect(existsSync(join(w.out, '.lock/pid'))).toBe(true);
    expect(existsSync(join(w.out, 'stages.log'))).toBe(false);
  });

  it('refuses to start while an rv2- container is still running (a killed runner orphans its containers)', () => {
    const w = world();
    calibrated(w);
    recordedPanel(w);
    exported(w);
    const r = stage(w, 'real', { STUB_PS: '0123456789ab' });
    expect(r.status).toBe(75);
    expect(r.out).toContain('0123456789ab');
    expect(r.calls.filter((c) => c[0] === 'ps')).toEqual([['ps', '-q', '--filter', 'name=^rv2-']]);
    expect(containerCalls(r.calls)).toHaveLength(0);
    // the lock is released, so the stage runs once the containers are gone
    expect(existsSync(join(w.out, '.lock'))).toBe(false);
    expect(stage(w, 'real').status).toBe(0);
  });

  it('refuses an unknown stage and any argument', () => {
    const w = world();
    expect(stage(w, 'all').status).toBe(64);
    const r = spawnSync('bash', [RUNBOOK, 'real', '--fast'], { env: { ...process.env, HOME: w.home }, encoding: 'utf8' });
    expect(r.status).toBe(64);
  });
});

const noRuns = (r: { runs: RunCall[]; out: string }) => expect(r.runs, r.out).toHaveLength(0);

describe('rv-revalidation-run.sh, the calibration gate (review I2)', { timeout: 30_000 }, () => {
  it('export refuses when the record behind calibration.pass names another commit', () => {
    const w = world();
    calibrated(w);
    writeFileSync(join(w.out, 'calibration.json'), `{\n  "gitCommit": "${'b'.repeat(40)}",\n  "pass": true\n}\n`);
    const r = stage(w, 'export');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/calibration\.json is not a PASS/);
    noRuns(r);
    expect(existsSync(w.ds)).toBe(false);
  });

  it('calibrate records no PASS when check-calibration exits 0 with a record that is not a PASS at this commit', () => {
    for (const mode of ['zero-fail', 'zero-other']) {
      const w = world();
      calibrationOutputs(w);
      const r = stage(w, 'calibrate', { STUB_CAL: mode });
      expect(r.status, mode).not.toBe(0);
      expect(r.out, mode).toMatch(/check-calibration exited 0 but/);
      expect(runsOf(r, 'calibrate'), mode).toHaveLength(0);
      expect(runsOf(r, 'check-calibration'), mode).toHaveLength(1);
      expect(existsSync(join(w.out, 'calibration.pass')), mode).toBe(false);
      expect(stage(w, 'export').status, mode).not.toBe(0);
    }
  });

  it('a calibrate rerun that fails removes the earlier PASS, and export then refuses', () => {
    const w = world();
    calibrationOutputs(w);
    let r = stage(w, 'calibrate');
    expect(r.status, r.out).toBe(0);
    expect(read(join(w.out, 'calibration.pass')).trim()).toBe(w.commit);
    r = stage(w, 'calibrate', { STUB_CAL: 'fail' });
    expect(r.status).toBe(2);
    expect(existsSync(join(w.out, 'calibration.pass'))).toBe(false);
    r = stage(w, 'export');
    expect(r.status).not.toBe(0);
    noRuns(r);
  });
});

describe('rv-revalidation-run.sh, every guard (review M1 to M5)', { timeout: 30_000 }, () => {
  it('resolve writes once: an existing resolutions file or record is refused', () => {
    const w = world();
    calibrated(w);
    exported(w);
    mkdirSync(join(w.out, 'inputs'), { recursive: true });
    for (const f of ['resolutions.json', 'resolve.json']) {
      writeFileSync(join(w.out, 'inputs', f), '[]\n');
      const r = stage(w, 'resolve');
      expect(r.status, f).not.toBe(0);
      expect(r.out, f).toMatch(/resolve writes once/);
      noRuns(r);
      rmSync(join(w.out, 'inputs', f));
    }
  });

  it('inputs writes once: an existing panel or record is refused', () => {
    const w = world();
    calibrated(w);
    exported(w);
    resolved(w);
    for (const f of ['inputs.json', 'panel.json.gz']) {
      writeFileSync(join(w.out, 'inputs', f), 'x');
      const r = stage(w, 'inputs');
      expect(r.status, f).not.toBe(0);
      expect(r.out, f).toMatch(/inputs writes once/);
      noRuns(r);
      rmSync(join(w.out, 'inputs', f));
    }
  });

  it('real, the shard stages and verdict refuse a missing panel, or one recorded at another commit or dataset', () => {
    const w = world();
    calibrated(w);
    exported(w);
    stagesDone(w, 'block');
    for (const s of ['real', 'is-mcpt', 'wf-mcpt', 'block', 'verdict']) {
      rmSync(join(w.out, 'inputs'), { recursive: true, force: true });
      let r = stage(w, s);
      expect(r.status, s).not.toBe(0);
      expect(r.out, s).toMatch(/run the inputs stage first/);
      noRuns(r);
      recordedPanel(w, 'b'.repeat(40));
      r = stage(w, s);
      expect(r.status, s).not.toBe(0);
      expect(r.out, s).toMatch(/inputs\.json was written by inputs at commit/);
      noRuns(r);
      recordedPanel(w);
      writeFileSync(join(w.out, 'inputs/inputs.json'), `{\n  "manifestHash": "${'e'.repeat(64)}",\n  "gitCommit": "${w.commit}"\n}\n`);
      r = stage(w, s);
      expect(r.status, s).not.toBe(0);
      expect(r.out, s).toMatch(/from dataset/);
      noRuns(r);
    }
  });

  it('each stage after real refuses until the stage before it has written its output (review M2)', () => {
    const w = world();
    calibrated(w);
    exported(w);
    recordedPanel(w);
    for (const [s, before] of [['is-mcpt', 'real'], ['wf-mcpt', 'is-mcpt'], ['block', 'wf-mcpt']]) {
      const r = stage(w, s);
      expect(r.status, s).not.toBe(0);
      expect(r.out, s).toContain(`run the ${before} stage first`);
      noRuns(r);
      writeFileSync(join(w.out, `${before}.json`), '{}\n');
    }
    for (const f of ['real', 'is-mcpt', 'wf-mcpt', 'block']) {
      stagesDone(w, 'block');
      rmSync(join(w.out, `${f}.json`));
      const r = stage(w, 'verdict');
      expect(r.status, f).not.toBe(0);
      expect(r.out, f).toContain(`run the ${f} stage first`);
      noRuns(r);
    }
  });

  it('a stray file in a shard or calibration directory fails the name check, and nothing is merged or checked', () => {
    const w = world();
    calibrated(w);
    exported(w);
    recordedPanel(w);
    stagesDone(w, 'real');
    mkdirSync(join(w.out, 'shards/is-mcpt'), { recursive: true });
    writeFileSync(join(w.out, 'shards/is-mcpt/notes.txt'), 'x');
    let r = stage(w, 'is-mcpt');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/name check failed[\s\S]*notes\.txt/);
    expect(runsOf(r, 'shard')).toHaveLength(8);
    expect(runsOf(r, 'merge')).toHaveLength(0);
    const v = world();
    calibrationOutputs(v);
    writeFileSync(join(v.out, 'calibration/extra.json'), '{}\n');
    r = stage(v, 'calibrate');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/name check failed[\s\S]*extra\.json/);
    expect(runsOf(r, 'check-calibration')).toHaveLength(0);
    expect(existsSync(join(v.out, 'calibration.pass'))).toBe(false);
  });

  it('the job lists are validated: universe count, repeats, and a shard line naming another stage', () => {
    const w = world();
    const lines = jobLines('calibrate');
    writeFileSync(join(w.home, 'stub/jobs-calibrate.txt'), `${lines.slice(1).join('\n')}\n`);
    let r = stage(w, 'calibrate');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/gave 129 jobs, expected 130/);
    expect(runsOf(r, 'calibrate')).toHaveLength(0);
    writeFileSync(join(w.home, 'stub/jobs-calibrate.txt'), `${[...lines.slice(0, -1), lines[0]].join('\n')}\n`);
    r = stage(w, 'calibrate');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/repeats: cal-iid-001/);
    expect(runsOf(r, 'calibrate')).toHaveLength(0);
    calibrated(w);
    exported(w);
    recordedPanel(w);
    stagesDone(w, 'real');
    const shards = jobLines('is-mcpt').map((l, i) => (i === 2 ? l.replace(' is-mcpt ', ' wf-mcpt ') : l));
    writeFileSync(join(w.home, 'stub/jobs-is-mcpt.txt'), `${shards.join('\n')}\n`);
    r = stage(w, 'is-mcpt');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/malformed line: 'is-mcpt-03 wf-mcpt/);
    expect(runsOf(r, 'shard')).toHaveLength(0);
  });

  it('resolve refuses a base URL that is not http(s), and fails when its container writes nothing or fails', () => {
    const w = world();
    calibrated(w);
    exported(w);
    writeFileSync(w.envFile, 'BINANCE_FUTURES_API_URL=fapi.binance.com\n');
    let r = stage(w, 'resolve');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/not an http\(s\) URL/);
    noRuns(r);
    writeFileSync(w.envFile, `BINANCE_FUTURES_API_URL=${REST_URL}\n`);
    r = stage(w, 'resolve', { STUB_SKIP: 'rv2-resolve-run' });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/resolve exited 0 without writing/);
    expect(r.out).not.toMatch(/CONTROLLER CHECKPOINT/);
    expect(lastStage(w)).toMatchObject({ stage: 'resolve', exit: 1, commit: w.commit });
    r = stage(w, 'resolve', { STUB_FAIL_AFTER: 'rv2-resolve-run' });
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/CONTROLLER CHECKPOINT/);
  });

  it('a container that fails after writing fails its stage, and its output is not kept', () => {
    const w = world();
    calibrated(w);
    let r = stage(w, 'export', { STUB_FAIL_AFTER: 'rv2-export-run' });
    expect(r.status).toBe(1);
    expect(existsSync(join(w.out, 'manifest-hash'))).toBe(false);
    expect(lastStage(w)).toMatchObject({ stage: 'export', exit: 1 });
    rmSync(w.ds, { recursive: true });
    exported(w);
    recordedPanel(w);
    r = stage(w, 'real', { STUB_FAIL_AFTER: 'rv2-real-run' });
    expect(r.status).toBe(1);
    expect(existsSync(join(w.out, 'real.json'))).toBe(false);
  });

  it('a move, write or directory that fails fails the stage (review M4)', () => {
    const w = world();
    calibrated(w);
    exported(w);
    recordedPanel(w);
    // settle cannot replace a directory that holds a directory of the same name
    mkdirSync(join(w.out, 'real.json', 'real.json'), { recursive: true });
    let r = stage(w, 'real');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/cannot move/);
    expect(lastStage(w).exit).toBe(r.status);
    // calibrate cannot write the run's image (a symlink into a directory that does not exist)
    const v = world();
    mkdirSync(v.out, { recursive: true });
    symlinkSync(join(v.home, 'gone', 'run-image'), join(v.out, 'run-image'));
    r = stage(v, 'calibrate');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/cannot write/);
    noRuns(r);
    // calibrate cannot make its output directory
    const u = world();
    mkdirSync(u.out, { recursive: true });
    writeFileSync(join(u.out, 'calibration'), 'not a directory');
    r = stage(u, 'calibrate');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/cannot create/);
    expect(runsOf(r, 'calibrate')).toHaveLength(0);
  });

  it('every stage after calibrate refuses an image whose ID changed under the same label (review M5)', () => {
    const w = world();
    calibrated(w);
    exported(w);
    recordedPanel(w);
    stagesDone(w, 'block');
    writeFileSync(join(w.home, 'stub/id'), 'sha256:rebuilt\n');
    for (const s of ['calibrate', 'resolve', 'inputs', 'real', 'is-mcpt', 'wf-mcpt', 'block', 'verdict']) {
      const r = stage(w, s);
      expect(r.status, s).not.toBe(0);
      expect(r.out, s).toContain('sha256:rebuilt');
      expect(r.out, s).toContain('sha256:stub');
      noRuns(r);
    }
  });

  it('a hang-up stops the stage like INT and TERM: containers stopped, exit 129 logged, lock released (review M3)', async () => {
    const w = world();
    calibrated(w);
    exported(w);
    recordedPanel(w);
    stagesDone(w, 'real');
    const env = { ...process.env, HOME: w.home, PATH: `${w.home}/bin:${process.env.PATH}`, RV2_ENV_FILE: w.envFile, STUB_SLEEP: '3' };
    const child = spawn('bash', [RUNBOOK, 'is-mcpt'], { env, stdio: 'ignore' });
    const events = join(w.home, 'events.log');
    const started = Date.now();
    while (!(existsSync(events) && read(events).includes('start rv2-is-mcpt-is-mcpt-01'))) {
      if (Date.now() - started > 15_000) throw new Error('the first shard never started');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    child.kill('SIGHUP');
    expect(await exited).toBe(129);
    expect(lastStage(w)).toMatchObject({ stage: 'is-mcpt', exit: 129 });
    expect(existsSync(join(w.out, '.lock'))).toBe(false);
    expect(dockerLog(w).filter((c) => c[0] === 'stop').map((c) => c[1])).toContain('rv2-is-mcpt-is-mcpt-01');
    expect(existsSync(join(w.out, 'is-mcpt.json'))).toBe(false);
  });
});

/** Polls until `done` holds, or fails after 15 s. */
async function until(done: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > 15_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('rv-revalidation-run.sh, the 7C re-review minors', { timeout: 30_000 }, () => {
  const envOf = (w: World, extra: Record<string, string>) => ({ ...process.env, HOME: w.home, PATH: `${w.home}/bin:${process.env.PATH}`, RV2_ENV_FILE: w.envFile, ...extra });
  const exitOf = (child: ReturnType<typeof spawn>) => new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const stageLines = (w: World, name: string) => read(join(w.out, 'stages.log')).trim().split('\n').map((l) => JSON.parse(l) as { stage: string; exit: number }).filter((l) => l.stage === name);

  it('a TERM during the lock\'s docker ps check releases the lock and logs exit 143 (m1: traps set before the lock)', async () => {
    const w = world();
    calibrated(w);
    exported(w);
    recordedPanel(w);
    const child = spawn('bash', [RUNBOOK, 'real'], { env: envOf(w, { STUB_PS_SLEEP: '2' }), stdio: 'ignore' });
    const exited = exitOf(child);
    await until(() => dockerLog(w).some((c) => c[0] === 'ps'), 'the lock\'s docker ps');
    child.kill('SIGTERM');
    expect(await exited).toEqual({ code: 143, signal: null });
    expect(existsSync(join(w.out, '.lock'))).toBe(false);
    expect(lastStage(w)).toMatchObject({ stage: 'real', exit: 143 });
    expect(containerCalls(dockerLog(w))).toHaveLength(0);
  });

  it('a hang-up during the TERM cleanup is ignored: exit 143 stands, one stages.log line (m1)', async () => {
    const w = world();
    calibrated(w);
    exported(w);
    recordedPanel(w);
    stagesDone(w, 'real');
    const child = spawn('bash', [RUNBOOK, 'is-mcpt'], { env: envOf(w, { STUB_SLEEP: '3', STUB_STOP_SLEEP: '1' }), stdio: 'ignore' });
    const exited = exitOf(child);
    const events = join(w.home, 'events.log');
    await until(() => existsSync(events) && read(events).includes('start rv2-is-mcpt-is-mcpt-01'), 'the first shard');
    child.kill('SIGTERM');
    await until(() => dockerLog(w).some((c) => c[0] === 'stop'), 'the first docker stop');
    child.kill('SIGHUP');
    expect(await exited).toEqual({ code: 143, signal: null });
    expect(stageLines(w, 'is-mcpt')).toEqual([expect.objectContaining({ exit: 143 })]);
    expect(existsSync(join(w.out, '.lock'))).toBe(false);
  });

  it('a signal before this run holds the lock leaves that lock alone and logs nothing (the LOCKED guard)', () => {
    const w = world();
    mkdirSync(join(w.out, 'logs'), { recursive: true });
    mkdirSync(join(w.out, '.lock'));
    writeFileSync(join(w.out, '.lock/pid'), '4242\n');
    /** A function of the runbook, by name, as written there. */
    const fn = (name: string) => {
      const m = new RegExp(`^${name}\\(\\) \\{(?:.*\\}$|\\n[\\s\\S]*?\\n\\}$)`, 'm').exec(runbook());
      if (!m) throw new Error(`no ${name} in the runbook`);
      return m[0];
    };
    const script = [`OUT='${w.out}'`, 'LOCK=$OUT/.lock', 'STAGE=real', 'GIT_COMMIT=', 'LOCKED=0', 'PIDS=()', 'CNAMES=()', fn('log'), fn('finish'), fn('on_signal'), 'on_signal TERM 143'];
    const r = spawnSync('bash', ['-c', script.join('\n')], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(143);
    expect(read(join(w.out, '.lock/pid'))).toBe('4242\n');
    expect(existsSync(join(w.out, 'stages.log'))).toBe(false);
  });

  it('refuses with exit 75 when docker ps fails, releasing the lock and running nothing (m2, X1)', () => {
    const w = world();
    calibrated(w);
    exported(w);
    recordedPanel(w);
    const r = stage(w, 'real', { STUB_PS_FAIL: '1' });
    expect(r.status).toBe(75);
    expect(r.out).toMatch(/docker ps failed/);
    expect(r.calls.filter((c) => c[0] === 'ps')).toHaveLength(1);
    expect(containerCalls(r.calls)).toHaveLength(0);
    expect(existsSync(join(w.out, '.lock'))).toBe(false);
    expect(existsSync(join(w.out, 'stages.log'))).toBe(false);
    expect(stage(w, 'real').status).toBe(0);
  });

  it('every stage refuses once run-image is gone, so deleting it cannot switch the image pin off (m2, X2)', () => {
    const w = world();
    calibrated(w);
    rmSync(join(w.out, 'run-image'));
    for (const s of ['export', 'resolve', 'inputs', 'real', 'is-mcpt', 'wf-mcpt', 'block', 'verdict', 'calibrate', 'build']) {
      // each stage gets what it needs from the stage before it, so only the missing pin can stop it
      if (s === 'resolve') exported(w);
      if (s === 'inputs') resolved(w);
      if (s === 'real') recordedPanel(w);
      if (s === 'is-mcpt') stagesDone(w, 'block');
      const r = stage(w, s);
      expect(r.status, s).not.toBe(0);
      expect(r.out, s).toMatch(/run-image: run the calibrate stage first/);
      expect(r.calls.filter((c) => c[0] === 'run' || c[0] === 'build'), s).toHaveLength(0);
    }
  });

  it('export refuses a dangling symlink at manifest-hash before the image is looked at (m2, X3)', () => {
    const w = world();
    calibrated(w);
    symlinkSync(join(w.home, 'gone', 'manifest-hash'), join(w.out, 'manifest-hash'));
    const r = stage(w, 'export');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`${join(w.out, 'manifest-hash')} exists: the study's dataset is exported once`);
    expect(r.calls.filter((c) => c[0] === 'image')).toHaveLength(0);
    expect(r.runs).toHaveLength(0);
    expect(existsSync(w.ds)).toBe(false);
  });
});
