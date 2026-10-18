import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, it, expect } from 'vitest';

import {
  CRON_JOBS,
  CRON_JOB_NAMES,
  DERIVED_JOBS,
  HEARTBEAT_JOBS,
  HEARTBEAT_JOB_NAMES,
  SERVICE_JOBS,
  cronJob,
  secondsBetweenRuns,
} from './cron-jobs';

/**
 * The anti-drift test. `CRON_JOBS` is the source of truth the app reads, and
 * `docker/crontab.template` is what actually runs; nothing but this test stops
 * them diverging, and a divergence reintroduces exactly the blindness the
 * heartbeat exists to remove (a job that stopped, reported as healthy, or a
 * job nobody is watching at all).
 */

const TEMPLATE = readFileSync(
  join(process.cwd(), 'docker', 'crontab.template'),
  'utf8'
);

/**
 * Non-HTTP crontab lines, whitelisted by an exact marker rather than a loose
 * regex so a second one cannot slip past unnoticed.
 */
const NON_HTTP_LINE_MARKERS = ['/var/log/cron.log'] as const;

interface ParsedLine {
  schedule: string;
  path: string;
  params: Record<string, string>;
  method: 'GET' | 'POST';
}

function parseTemplate(): ParsedLine[] {
  const lines: ParsedLine[] = [];

  for (const raw of TEMPLATE.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // The log-truncation line is a shell command, not a job.
    if (!line.includes('wget')) {
      const whitelisted = NON_HTTP_LINE_MARKERS.some((m) => line.includes(m));
      expect(whitelisted, `unrecognised non-wget crontab line: ${line}`).toBe(true);
      continue;
    }

    const fields = line.split(/\s+/);
    const schedule = fields.slice(0, 5).join(' ');

    const urlMatch = /https?:\/\/[^\s"']+/.exec(line);
    expect(urlMatch, `no URL in crontab line: ${line}`).not.toBeNull();
    const url = new URL(urlMatch![0]);

    const params: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      params[k] = v;
    });

    lines.push({
      schedule,
      path: url.pathname,
      params,
      // --post-data is how the template issues a POST.
      method: line.includes('--post-data') ? 'POST' : 'GET',
    });
  }

  return lines;
}

const parsed = parseTemplate();

function keyOf(p: Pick<ParsedLine, 'path' | 'params'>): string {
  const entries = Object.entries(p.params).sort(([a], [b]) => a.localeCompare(b));
  return `${p.path}?${entries.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

describe('CRON_JOBS matches docker/crontab.template', () => {
  it('parses every scheduled HTTP line in the template', () => {
    // Guards the parser itself: if the regex silently matched nothing, every
    // bijection assertion below would pass vacuously.
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBe(CRON_JOBS.length);
  });

  it('has exactly one table entry per crontab line', () => {
    const templateKeys = parsed.map(keyOf).sort();
    const tableKeys = CRON_JOBS.map(keyOf).sort();

    expect(tableKeys).toEqual(templateKeys);
  });

  it('records each line\'s schedule verbatim', () => {
    for (const line of parsed) {
      const spec = CRON_JOBS.find((j) => keyOf(j) === keyOf(line));
      expect(spec, `no CRON_JOBS entry for ${keyOf(line)}`).toBeDefined();
      // Whitespace is normalised on both sides; the template aligns columns.
      expect(spec!.schedule.split(/\s+/).join(' ')).toBe(line.schedule);
    }
  });

  it('records each line\'s HTTP method', () => {
    for (const line of parsed) {
      const spec = CRON_JOBS.find((j) => keyOf(j) === keyOf(line));
      expect(spec!.method).toBe(line.method);
    }
  });

  it('derives expectedEverySeconds from the schedule', () => {
    for (const spec of CRON_JOBS) {
      expect(
        secondsBetweenRuns(spec.schedule),
        `${spec.job} declares ${spec.expectedEverySeconds}s for "${spec.schedule}"`
      ).toBe(spec.expectedEverySeconds);
    }
  });
});

describe('CRON_JOBS table', () => {
  it('has unique job keys', () => {
    expect(new Set(CRON_JOB_NAMES).size).toBe(CRON_JOB_NAMES.length);
  });

  it('keys a route that runs on several schedules by its distinguishing param', () => {
    // The whole reason the key is not the route: these would otherwise share
    // one heartbeat and the slowest line would mask the others dying.
    const syncCandles = CRON_JOBS.filter((j) => j.path === '/api/cron/sync-candles');
    expect(syncCandles).toHaveLength(3);
    expect(new Set(syncCandles.map((j) => j.job)).size).toBe(3);

    // Four, one per trading style. The fifth was the legacy per-user pass,
    // retired once nothing read the `Signal` collection it wrote.
    const computeSignals = CRON_JOBS.filter((j) => j.path === '/api/cron/compute-signals');
    expect(computeSignals).toHaveLength(4);
    expect(new Set(computeSignals.map((j) => j.job)).size).toBe(4);
    expect(computeSignals.every((j) => typeof j.params.style === 'string')).toBe(true);

    // The rv-v1 signal job and its retry line: a failing first attempt must
    // stay visible even when the retry succeeds.
    const rvSignals = CRON_JOBS.filter((j) => j.path === '/api/cron/cross-sectional-signals');
    expect(rvSignals.map((j) => j.job)).toEqual(['cross-sectional-signals', 'cross-sectional-signals:retry']);

    const labSignals = CRON_JOBS.filter((j) => j.path === '/api/cron/lab-signals');
    expect(labSignals.map((j) => j.job)).toEqual(['lab-signals:8h', 'lab-signals:8h:retry', 'lab-signals:fast']);
  });

  it('no longer schedules the monthly optimization (the route and admin trigger stay)', () => {
    expect(CRON_JOB_NAMES).not.toContain('monthly-optimization');
    expect(cronJob('monthly-optimization')).toBeUndefined();
    expect(TEMPLATE).not.toContain('/api/cron/monthly-optimization');
    expect(HEARTBEAT_JOBS).toHaveLength(CRON_JOBS.length);
  });

  it('looks a job up by key', () => {
    expect(cronJob('ingest-perp')?.path).toBe('/api/cron/ingest-perp');
    expect(cronJob('nope')).toBeUndefined();
  });
});

describe('DERIVED_JOBS', () => {
  it('no longer expects the retired LLM panel anywhere', () => {
    // Retired 2026-10-16 with its VPS host crontab line. Kept as a derived job,
    // it read the newest stored call, went overdue and held /api/health/cron at 503.
    expect(DERIVED_JOBS.some((j) => j.job === 'llm-panel')).toBe(false);
    expect(CRON_JOB_NAMES).not.toContain('llm-panel');
    expect(TEMPLATE).not.toContain('llm-panel');
  });

  it('does not derive the retired monthly optimization job', () => {
    expect(DERIVED_JOBS.some((j) => j.job === 'monthly-optimization')).toBe(false);
  });

  it('says where every derived job reads its state from', () => {
    for (const job of DERIVED_JOBS) {
      expect(job.derivedFrom, `${job.job} must say what it derives from`).toBeTruthy();
      expect(job.expectedEverySeconds).toBeGreaterThan(0);
    }
  });
});

describe('SERVICE_JOBS', () => {
  it('keeps long-running services out of the crontab table and the template', () => {
    // A service has no crontab line, so the bijection test must never demand one.
    for (const service of SERVICE_JOBS) {
      expect(CRON_JOB_NAMES).not.toContain(service.job);
      expect(DERIVED_JOBS.some((j) => j.job === service.job)).toBe(false);
      expect(TEMPLATE).not.toContain(service.job);
    }
  });

  it('allows a heartbeat row for every crontab line and every service, and nothing else', () => {
    expect(HEARTBEAT_JOB_NAMES).toEqual([...CRON_JOB_NAMES, ...SERVICE_JOBS.map((j) => j.job)]);
    expect(new Set(HEARTBEAT_JOB_NAMES).size).toBe(HEARTBEAT_JOB_NAMES.length);
    expect(HEARTBEAT_JOB_NAMES).toContain('market-recorder');
  });

  it('expects the market recorder every minute and says where it runs', () => {
    const recorder = SERVICE_JOBS.find((j) => j.job === 'market-recorder');

    expect(recorder?.expectedEverySeconds).toBe(60);
    expect(recorder?.runsIn).toMatch(/market-recorder\.ts/);
  });
});

describe('secondsBetweenRuns', () => {
  it.each([
    ['*/1 * * * *', 60],
    ['*/5 * * * *', 300],
    ['*/10 * * * *', 600],
    ['*/15 * * * *', 900],
    ['1-59/5 * * * *', 300],
    ['1-59/15 * * * *', 900],
    ['1 * * * *', 3600],
    ['0 */4 * * *', 14400],
    ['5 1-23/8 * * *', 28800],
    ['0 0-23/4 * * *', 14400],
    ['0 0 * * *', 86400],
    ['30 5 * * *', 86400],
    ['0 0 1 * *', 31 * 86400],
  ])('reads %s as %i seconds', (expression, seconds) => {
    expect(secondsBetweenRuns(expression)).toBe(seconds);
  });

  it('treats an offset step the same as a plain step', () => {
    // 1-59/5 and */5 both fire twelve times an hour; only the phase differs.
    expect(secondsBetweenRuns('1-59/5 * * * *')).toBe(secondsBetweenRuns('*/5 * * * *'));
  });

  it.each([
    ['* * * * *'],
    ['0 0 * * 1'],
    ['0 0 1 6 *'],
    ['*/5 9-17 * * *'],
    ['0,30 * * * *'],
    ['*/5 * * *'],
  ])('throws on the unsupported expression %s', (expression) => {
    // Loud failure is the point: an unrecognised shape must not be silently
    // mis-measured, because a job whose expected interval is wrong is a job
    // that never reports overdue.
    expect(() => secondsBetweenRuns(expression)).toThrow(/Unsupported cron expression/);
  });
});
