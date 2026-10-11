// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
