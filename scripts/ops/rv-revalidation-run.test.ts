// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCK_M, IS_M, WF_M } from '../research/rv-mcpt';
import { RV_SPAN, RV_SYMBOLS } from '../research/rv-panel';
import { jobLines } from '../research/rv-judge';
import { calibrationJobs, shardJobs, type ShardStage } from '../research/rv-stages';

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

/** Runs one stage with the stub docker first on PATH; returns its status, output and the docker calls it made. */
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
  mkdirSync(join(w.out, 'calibration'), { recursive: true });
  writeFileSync(join(w.out, 'run-commit'), `${commit}\n`);
  writeFileSync(join(w.out, 'calibration.json'), `{\n  "gitCommit": "${commit}",\n  "pass": true\n}\n`);
  writeFileSync(join(w.out, 'calibration.pass'), `${commit}\n`);
}

/** The state export leaves. */
function exported(w: World): void {
  mkdirSync(w.ds, { recursive: true });
  writeFileSync(join(w.ds, 'manifest.json'), `{"datasetHash":"${DATASET}"}\n`);
  writeFileSync(join(w.out, 'manifest-hash'), `${DATASET}\n`);
}

describe('rv-revalidation-run.sh', () => {
  it('parses', () => {
    expect(() => execFileSync('bash', ['-n', RUNBOOK])).not.toThrow();
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
    const calNames = calibrationJobs().map((j) => j.name);
    const calRuns = calibration.filter((c) => c.cmd[3] === 'calibrate');
    expect(sorted(calRuns.map((c) => c.cmd.slice(3).join(' ')))).toEqual(sorted(calNames.map((n) => `calibrate --name ${n} --out /app/out/part/${n}.json`)));
    expect(sorted(readdirSync(join(w.out, 'calibration')))).toEqual(sorted(calNames.map((n) => `${n}.json`)));
    const check = calibration.filter((c) => c.cmd[3] === 'check-calibration');
    expect(check.map((c) => c.cmd.slice(2))).toEqual([['scripts/research/rv-judge.ts', 'check-calibration', '--dir', '/app/out/calibration', '--out', '/app/out/part/calibration.json']]);
    expect(read(join(w.out, 'calibration.pass')).trim()).toBe(w.commit);
    expect(read(join(w.out, 'calibration.json'))).toContain(`"gitCommit": "${w.commit}"`);
    expect(calibration.every((c) => c.mounts.every((m) => !m.includes(':/app/ds')))).toBe(true);
    expect(calibration.filter((c) => c.cmd[3] === 'jobs').map((c) => c.cmd.slice(3))).toEqual([['jobs', 'calibrate']]);
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
    expect(res.cmd).toEqual(['npx', 'tsx', 'scripts/research/rv-stages.ts', 'resolve', '--dataset-dir', '/app/ds', '--out-dir', '/app/out/inputs', '--expect-manifest-hash', H]);
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
    expect(inp.cmd).toEqual([
      'npx', 'tsx', 'scripts/research/rv-stages.ts', 'inputs', '--dataset-dir', '/app/ds', '--out-dir', '/app/out/inputs',
      '--resolutions', '/app/out/inputs/resolutions.json', '--expect-manifest-hash', H,
    ]);

    // real
    r = stage(w, 'real');
    expect(r.status, r.out).toBe(0);
    expect(r.runs.map((c) => c.cmd.slice(2))).toEqual([['scripts/research/rv-stages.ts', 'real', '--inputs-dir', '/app/out/inputs', '--expect-manifest-hash', H, '--out', '/app/out/part/real.json']]);
    expect(existsSync(join(w.out, 'real.json'))).toBe(true);

    // the three permutation stages: the judge's jobs, two containers at once, one directory per stage, then merge
    for (const s of SHARD_STAGES) {
      rmSync(join(w.home, 'events.log'));
      r = stage(w, s, { STUB_SLEEP: '0.15' });
      expect(r.status, r.out).toBe(0);
      const names = shardJobs(s).map((j) => j.name);
      expect(names).toHaveLength(8);
      const shards = r.runs.filter((c) => c.cmd[3] === 'shard');
      expect(sorted(shards.map((c) => c.cmd.slice(2).join(' ')))).toEqual(
        sorted(names.map((n) => `scripts/research/rv-stages.ts shard --stage ${s} --name ${n} --inputs-dir /app/out/inputs --expect-manifest-hash ${H} --out /app/out/part/${n}.jsonl`))
      );
      expect(sorted(readdirSync(join(w.out, 'shards', s)))).toEqual(names.map((n) => `${n}.jsonl`));
      expect(maxAlive(w)).toBe(2);
      const merge = r.runs.filter((c) => c.cmd[3] === 'merge');
      expect(merge.map((c) => c.cmd.slice(2))).toEqual([
        ['scripts/research/rv-judge.ts', 'merge', '--stage', s, '--dir', `/app/out/shards/${s}`, '--inputs-dir', '/app/out/inputs', '--expect-manifest-hash', H, '--out', `/app/out/part/${s}.json`],
      ]);
      expect(existsSync(join(w.out, `${s}.json`))).toBe(true);
    }

    // verdict: dsr, then the verdict with the calibration record and the 130 outputs
    r = stage(w, 'verdict');
    expect(r.status, r.out).toBe(0);
    expect(r.runs.map((c) => c.cmd.slice(2))).toEqual([
      ['scripts/research/rv-judge.ts', 'dsr', '--real', '/app/out/real.json', '--inputs-dir', '/app/out/inputs', '--expect-manifest-hash', H],
      [
        'scripts/research/rv-judge.ts', 'verdict', '--real', '/app/out/real.json', '--is', '/app/out/is-mcpt.json', '--wf', '/app/out/wf-mcpt.json',
        '--block', '/app/out/block.json', '--calibration', '/app/out/calibration.json', '--calibration-dir', '/app/out/calibration',
        '--inputs-dir', '/app/out/inputs', '--expect-manifest-hash', H, '--out', '/app/out/part/verdict.json',
      ],
    ]);
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
      expect(c.network, c.name).toHaveLength(1);
      // no working tree over /app: the image is the code
      expect(c.mounts.every((m) => !/:\/app(:|$)/.test(m)), c.name).toBe(true);
      const isExport = c.cmd[2] === 'scripts/research/export-dataset.ts';
      const isRest = c.cmd[2] === 'scripts/research/rv-stages.ts' && (c.cmd[3] === 'resolve' || c.cmd[3] === 'inputs');
      expect(c.network[0], c.name).toBe(isExport ? 'crypto_crypto-internal' : isRest ? 'bridge' : 'none');
      expect(valuesOf(c.flags, '--env-file').length > 0, c.name).toBe(isExport);
      expect(c.env.some((e) => e.startsWith('BINANCE_FUTURES_API_URL=')), c.name).toBe(isRest);
      expect(c.mounts.some((m) => m.endsWith(':/app/ds:ro')), c.name).toBe(isRest);
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

  it('export refuses an existing $HOME/rv2-ds, even after a PASS', () => {
    const w = world();
    calibrated(w);
    mkdirSync(w.ds);
    const r = stage(w, 'export');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(w.ds);
    noRun(r);
    expect(dockerLog(w)).toHaveLength(0);
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
    mkdirSync(join(w.out, 'inputs'), { recursive: true });
    writeFileSync(join(w.out, 'inputs/panel.json.gz'), 'panel');
    writeFileSync(join(w.out, 'inputs/inputs.json'), `{\n  "manifestHash": "${DATASET}",\n  "gitCommit": "${w.commit}"\n}\n`);
    const lines = jobLines('is-mcpt');
    writeFileSync(join(w.home, 'stub/jobs-is-mcpt.txt'), `${lines.filter((_, i) => i !== 3).join('\n')}\n`);
    r = stage(w, 'is-mcpt');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/is-mcpt-05/);
    expect(r.runs.filter((c) => c.cmd[3] === 'shard')).toHaveLength(0);
  });

  it('keeps a failed shard out of the stage directory and does not merge', () => {
    const w = world();
    calibrated(w);
    exported(w);
    mkdirSync(join(w.out, 'inputs'), { recursive: true });
    writeFileSync(join(w.out, 'inputs/panel.json.gz'), 'panel');
    writeFileSync(join(w.out, 'inputs/inputs.json'), `{\n  "manifestHash": "${DATASET}",\n  "gitCommit": "${w.commit}"\n}\n`);
    let r = stage(w, 'wf-mcpt', { STUB_FAIL: 'rv2-wf-mcpt-wf-mcpt-03' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/wf-mcpt-03/);
    expect(readdirSync(join(w.out, 'shards/wf-mcpt'))).not.toContain('wf-mcpt-03.jsonl');
    expect(readdirSync(join(w.out, 'shards/wf-mcpt'))).toHaveLength(7);
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
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/4242/);
    expect(dockerLog(w)).toHaveLength(0);
    expect(existsSync(join(w.out, '.lock/pid'))).toBe(true);
  });

  it('refuses an unknown stage and any argument', () => {
    const w = world();
    expect(stage(w, 'all').status).toBe(64);
    const r = spawnSync('bash', [RUNBOOK, 'real', '--fast'], { env: { ...process.env, HOME: w.home }, encoding: 'utf8' });
    expect(r.status).toBe(64);
  });
});
