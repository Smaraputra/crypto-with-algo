// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DIRECTION_EXIT_CONFIRM, DIRECTION_EXIT_DEVELOP, DIRECTION_EXIT_EXPORT, DIRECTION_EXIT_SYMBOLS,
} from '../research/direction-exit';
import { REPORT_NAME_PATTERN } from '../research/direction-exit-judge';
import { DIRECTION_EXIT_REPRO_WINDOW } from '../research/direction-exit-repro';

const RUNBOOK = join(__dirname, 'direction-exit-run.sh');
const text = readFileSync(RUNBOOK, 'utf8');
/** The value of a top-level `NAME=value` or `NAME='value'` assignment in the runbook. */
function assigned(name: string): string {
  const m = new RegExp(`^${name}=(.*)$`, 'm').exec(text);
  if (!m) throw new Error(`${name} is not assigned in the runbook`);
  return m[1].replace(/^'(.*)'$/, '$1');
}
const iso = (v: string) => new Date(v).toISOString();

describe('direction-exit-run.sh', () => {
  it('parses', () => {
    expect(() => execFileSync('bash', ['-n', RUNBOOK])).not.toThrow();
  });

  it('uses the judge report-name pattern verbatim', () => {
    expect(assigned('NAME_RE')).toBe(REPORT_NAME_PATTERN);
  });

  it('pins the ten study symbols', () => {
    expect(assigned('SYMBOLS')).toBe(DIRECTION_EXIT_SYMBOLS.join(','));
  });

  it('uses the spec windows', () => {
    expect(iso(assigned('DS_START'))).toBe(DIRECTION_EXIT_EXPORT.start);
    expect(iso(assigned('DS_END'))).toBe(DIRECTION_EXIT_EXPORT.end);
    expect(iso(assigned('DEV_START'))).toBe(DIRECTION_EXIT_DEVELOP.start);
    expect(iso(assigned('DEV_END'))).toBe(DIRECTION_EXIT_DEVELOP.end);
    expect(iso(assigned('CONF_START'))).toBe(DIRECTION_EXIT_CONFIRM.start);
    expect(iso(assigned('CONF_END'))).toBe(DIRECTION_EXIT_CONFIRM.end);
    expect(iso(assigned('REPRO_START'))).toBe(DIRECTION_EXIT_REPRO_WINDOW.start);
  });
});

/** direction-exit.ts as the study would carry it, with the three committed-constant declarations parameterised. */
function sourceOf(v: { fit: string; level: string; cond: string; sel: string }): string {
  return [
    '/** Locked header. */',
    `export const VERDICT_LEVEL = ${v.level};`,
    "export const DIRECTION_EXIT_FIT: Record<'1h' | '4h', Fit | null> = {",
    `  '1h': ${v.fit},`,
    "  '4h': null,",
    '};',
    'export const BOOTSTRAP = 10000;',
    `export const DIRECTION_EXIT_SELECTION: Record<'1h' | '4h', Sel | null> = { '1h': ${v.sel}, '4h': null };`,
    `export const DIRECTION_EXIT_D2_CONDITION: Record<'1h' | '4h', 1 | 2 | 3 | 4 | null> = { '1h': ${v.cond}, '4h': null };`,
    'export const CONFIRM_PARTS = 2;',
    '',
  ].join('\n');
}

/**
 * Runs the develop-b stage with a stub docker over a synthetic checkout whose direction-exit.ts goes from `before` to
 * `after`. The stub's `run` fails, so the stage stops right after the code check; its output tells the check's result.
 */
function codeCheck(before: string, after: string): { status: number | null; out: string } {
  const home = mkdtempSync(join(tmpdir(), 'dx-run-'));
  const build = join(home, 'crypto-archive-build');
  const git = (...a: string[]) => execFileSync('git', ['-C', build, ...a], { encoding: 'utf8' }).trim();
  mkdirSync(join(build, 'scripts/research'), { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const file = join(build, 'scripts/research/direction-exit.ts');
  writeFileSync(file, before);
  git('add', '-A');
  git('commit', '-qm', 'before');
  const from = git('rev-parse', 'HEAD');
  writeFileSync(file, after);
  git('add', '-A');
  git('commit', '-qm', 'after');
  const to = git('rev-parse', 'HEAD');
  mkdirSync(join(home, 'dx-out'), { recursive: true });
  writeFileSync(join(home, 'dx-out/manifest-hash'), `${'a'.repeat(64)}\n`);
  writeFileSync(join(home, 'dx-out/cond.json'), JSON.stringify({ '1h': 3, '4h': 2, gitCommit: from }));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/bash\ncase "$1" in\n  image) case "$*" in *Labels*) echo ${to} ;; *) echo sha256:stub ;; esac ;;\n  run) exit 1 ;;\nesac\n`
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const r = spawnSync('bash', [RUNBOOK, 'develop-b'], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('direction-exit-run.sh code check', () => {
  const base = { fit: 'null', level: '0.05', cond: 'null', sel: 'null' };

  it('passes when only the FIT, D2 condition and selection declarations changed, multi-line included', () => {
    const after = sourceOf({ ...base, fit: '{ slope: [1, 2], intercept: 0.1 }', cond: '3', sel: '{ d2Condition: 3 }' });
    const r = codeCheck(sourceOf(base), after);
    expect(r.out).toContain('code check ok');
    expect(r.out).not.toContain('code changed');
  });

  it('fails when VERDICT_LEVEL changed, even alongside a legitimate constant change', () => {
    const r = codeCheck(sourceOf(base), sourceOf({ ...base, level: '0.5', fit: '{ slope: [1] }' }));
    expect(r.out).toContain('outside the committed constants');
    expect(r.out).not.toContain('code check ok');
    expect(r.status).toBe(1);
  });

  it('fails when a line of the file outside the declarations was added', () => {
    const r = codeCheck(sourceOf(base), `${sourceOf(base)}export const EXTRA = 1;\n`);
    expect(r.out).toContain('outside the committed constants');
  });

  it('fails when a declaration loses its terminator and swallows the code after it', () => {
    const open = sourceOf(base).replace("'4h': null,\n};", "'4h': null,\n}");
    const r = codeCheck(sourceOf(base), open);
    expect(r.out).toContain('code changed');
    expect(r.out).not.toContain('code check ok');
  });
});
