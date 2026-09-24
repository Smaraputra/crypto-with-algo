import { describe, it, expect } from 'vitest';

import { classifyJob, graceSecondsFor, summarize, isAllHealthy, type JobState } from './cron-health';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

/** A 15-minute job: expected 900s, grace 1020s, so overdue past 1920s. */
const spec = { job: 'resolve-outcomes', schedule: '*/15 * * * *', expectedEverySeconds: 900 };

const agoSeconds = (s: number) => new Date(NOW - s * 1000);

function healthy(overrides: Partial<JobState> = {}): JobState {
  return {
    lastRunAt: agoSeconds(60),
    lastSuccessAt: agoSeconds(60),
    lastStatus: 'success',
    consecutiveFailures: 0,
    lastDurationMs: 42,
    lastResult: { resolved: 3 },
    ...overrides,
  };
}

describe('graceSecondsFor', () => {
  it.each([
    [60, 180],
    [900, 1020],
    [3600, 3720],
    [86400, 3720],
  ])('gives a %is job %is of grace', (expectedEverySeconds, expected) => {
    expect(graceSecondsFor({ expectedEverySeconds })).toBe(expected);
  });

  it('caps grace at an hour so a daily job is not given an extra day', () => {
    expect(graceSecondsFor({ expectedEverySeconds: 86400 })).toBeLessThan(86400);
  });
});

describe('classifyJob', () => {
  it('reports a recent success as healthy', () => {
    expect(classifyJob(spec, healthy(), NOW).state).toBe('healthy');
  });

  it('reports a missing heartbeat as never_ran', () => {
    const result = classifyJob(spec, null, NOW);

    expect(result.state).toBe('never_ran');
    expect(result.lastRunAt).toBeNull();
    expect(result.sinceSuccessSeconds).toBeNull();
  });

  it('reports a job that has never succeeded or run as never_ran, not overdue', () => {
    expect(classifyJob(spec, { lastRunAt: null, lastSuccessAt: null }, NOW).state).toBe('never_ran');
  });

  it('reports a stale success as overdue', () => {
    const result = classifyJob(spec, healthy({ lastSuccessAt: agoSeconds(5000), lastRunAt: agoSeconds(5000) }), NOW);

    expect(result.state).toBe('overdue');
    expect(result.sinceSuccessSeconds).toBe(5000);
  });

  it('reports a failed most-recent run as failing', () => {
    const result = classifyJob(
      spec,
      healthy({ lastStatus: 'failure', lastError: 'boom', lastFailureAt: agoSeconds(30), consecutiveFailures: 4 }),
      NOW
    );

    expect(result.state).toBe('failing');
    expect(result.lastError).toBe('boom');
    expect(result.consecutiveFailures).toBe(4);
  });

  it('does NOT report a job failing every minute as healthy', () => {
    // The whole point of measuring staleness off lastSuccessAt. This job ran
    // 10 seconds ago, so any check keyed on lastRunAt would call it fresh.
    const result = classifyJob(
      spec,
      { lastRunAt: agoSeconds(10), lastSuccessAt: agoSeconds(40000), lastStatus: 'failure', lastError: 'nope' },
      NOW
    );

    expect(result.state).toBe('failing');
  });

  it('reports a long-dead job as overdue even when its last run succeeded', () => {
    // The LLM panel shape: it stopped entirely, so the last thing on record is
    // a success from three days ago.
    const result = classifyJob(
      { job: 'llm-panel', schedule: '7 */2 * * *', expectedEverySeconds: 7200 },
      { lastRunAt: agoSeconds(3 * 86400), lastSuccessAt: agoSeconds(3 * 86400), lastStatus: 'success' },
      NOW
    );

    expect(result.state).toBe('overdue');
  });

  it('is still healthy exactly on the boundary and overdue one second past it', () => {
    const boundary = spec.expectedEverySeconds + graceSecondsFor(spec); // 1920

    expect(classifyJob(spec, healthy({ lastSuccessAt: agoSeconds(boundary) }), NOW).state).toBe('healthy');
    expect(classifyJob(spec, healthy({ lastSuccessAt: agoSeconds(boundary + 1) }), NOW).state).toBe('overdue');
  });

  it('carries the run result and schedule through for inspection', () => {
    const result = classifyJob(spec, healthy(), NOW);

    expect(result.lastResult).toEqual({ resolved: 3 });
    expect(result.schedule).toBe('*/15 * * * *');
    expect(result.expectedEverySeconds).toBe(900);
    expect(result.lastDurationMs).toBe(42);
  });
});

describe('summarize', () => {
  const at = (state: 'healthy' | 'overdue' | 'failing' | 'never_ran') =>
    classifyJob(
      spec,
      state === 'never_ran'
        ? null
        : state === 'failing'
          ? healthy({ lastStatus: 'failure' })
          : state === 'overdue'
            ? healthy({ lastSuccessAt: agoSeconds(99999) })
            : healthy(),
      NOW
    );

  it('counts each state', () => {
    const summary = summarize([at('healthy'), at('healthy'), at('overdue'), at('failing'), at('never_ran')]);

    expect(summary).toEqual({ healthy: 2, overdue: 1, failing: 1, never_ran: 1 });
  });

  it('treats an all-healthy summary as healthy and anything else as not', () => {
    expect(isAllHealthy(summarize([at('healthy')]))).toBe(true);
    expect(isAllHealthy(summarize([at('healthy'), at('overdue')]))).toBe(false);
    expect(isAllHealthy(summarize([at('healthy'), at('never_ran')]))).toBe(false);
    expect(isAllHealthy(summarize([at('healthy'), at('failing')]))).toBe(false);
  });

  it('counts an empty list as healthy', () => {
    expect(isAllHealthy(summarize([]))).toBe(true);
  });
});
