import type { CronJobSpec } from '@/lib/cron-jobs';

/**
 * Turns a job's spec and its latest state into a health verdict.
 *
 * Pure and dependency-free, following the `inputs/packet.ts` precedent, so the
 * classification is tested without Mongo or the network and the route does
 * nothing but read documents and hand them over.
 */

export type JobHealthState = 'healthy' | 'overdue' | 'failing' | 'never_ran';

/**
 * The subset of a heartbeat the classifier needs. Loosened from
 * `IJobHeartbeat` so a DERIVED entry can be classified the same way: the LLM
 * panel runs from the VPS host crontab and never calls this app, and
 * `monthly-optimization` is fire-and-forget, so both supply a `lastSuccessAt`
 * read from their own records rather than from a heartbeat row.
 */
export interface JobState {
  lastRunAt?: Date | null;
  lastSuccessAt?: Date | null;
  lastFailureAt?: Date | null;
  lastStatus?: 'success' | 'failure' | null;
  lastError?: string | null;
  consecutiveFailures?: number;
  lastDurationMs?: number | null;
  lastResult?: unknown;
}

export interface JobHealth {
  job: string;
  state: JobHealthState;
  schedule: string;
  expectedEverySeconds: number;
  graceSeconds: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  sinceSuccessSeconds: number | null;
  lastFailureAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastDurationMs: number | null;
  lastResult: unknown;
}

/**
 * How late a job may be before it is called overdue.
 *
 * One missed tick is noise (a slow run, a restart); two are a pattern. The
 * hour ceiling stops a daily job needing a full extra day to be flagged, and
 * the two-minute floor keeps a 1-minute job from flapping on a slow run.
 */
export function graceSecondsFor(spec: Pick<CronJobSpec, 'expectedEverySeconds'>): number {
  return Math.min(spec.expectedEverySeconds, 3600) + 120;
}

export function classifyJob(
  spec: Pick<CronJobSpec, 'job' | 'schedule' | 'expectedEverySeconds'>,
  state: JobState | null,
  nowMs: number
): JobHealth {
  const graceSeconds = graceSecondsFor(spec);
  const lastSuccessAt = state?.lastSuccessAt ?? null;
  const sinceSuccessSeconds =
    lastSuccessAt != null ? Math.floor((nowMs - lastSuccessAt.getTime()) / 1000) : null;

  const base = {
    job: spec.job,
    schedule: spec.schedule,
    expectedEverySeconds: spec.expectedEverySeconds,
    graceSeconds,
    lastRunAt: state?.lastRunAt?.toISOString() ?? null,
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    sinceSuccessSeconds,
    lastFailureAt: state?.lastFailureAt?.toISOString() ?? null,
    lastError: state?.lastError ?? null,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    lastDurationMs: state?.lastDurationMs ?? null,
    lastResult: state?.lastResult ?? null,
  };

  // Precedence matters. A job that has never run is not "overdue since the
  // epoch", and a job whose most recent attempt failed is failing even if an
  // older success is still inside the window.
  if (state == null || (state.lastRunAt == null && lastSuccessAt == null)) {
    return { ...base, state: 'never_ran' };
  }

  if (state.lastStatus === 'failure') {
    return { ...base, state: 'failing' };
  }

  // Measured off lastSuccessAt, NEVER lastRunAt. A job failing every single
  // minute has a lastRunAt seconds old and would read fresh on the naive
  // check -- which is exactly the shape of the outage this was built after.
  if (lastSuccessAt == null || sinceSuccessSeconds! > spec.expectedEverySeconds + graceSeconds) {
    return { ...base, state: 'overdue' };
  }

  return { ...base, state: 'healthy' };
}

export interface CronHealthSummary {
  healthy: number;
  overdue: number;
  failing: number;
  never_ran: number;
}

export function summarize(jobs: JobHealth[]): CronHealthSummary {
  const summary: CronHealthSummary = { healthy: 0, overdue: 0, failing: 0, never_ran: 0 };
  for (const job of jobs) summary[job.state] += 1;
  return summary;
}

/** Every job healthy, or nothing to report. */
export function isAllHealthy(summary: CronHealthSummary): boolean {
  return summary.overdue === 0 && summary.failing === 0 && summary.never_ran === 0;
}
