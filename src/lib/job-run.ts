import { NextRequest, NextResponse } from 'next/server';

import { CRON_JOB_NAMES } from '@/lib/cron-jobs';
import { connectDB } from '@/lib/mongodb';
import { JobHeartbeat } from '@/lib/models/job-heartbeat';

/**
 * Records that a scheduled job ran, so a job that stops or starts failing is
 * visible without reading `/var/log/cron.log`.
 *
 * The wrapper exists rather than a call in each route because the alternative
 * is eight copies of the same try/catch/duration/error-extraction, and the
 * first one somebody forgets is a job that looks healthy because it never
 * reports -- the exact failure this is built to remove.
 */

export interface JobRunOutcome {
  ok: boolean;
  durationMs: number;
  result?: unknown;
  error?: string | null;
}

/**
 * Upserts one job's row. NEVER THROWS: observability that can 500 a live cron
 * route is worse than none, so every failure here is swallowed after a log.
 */
export async function recordJobRun(job: string, outcome: JobRunOutcome): Promise<void> {
  // The schema's enum does NOT cover this path: mongoose runs validators on
  // updateOne only with runValidators, and never on $setOnInsert. Without this
  // guard an unrecognised key (a route called with a parameter no crontab line
  // uses) quietly creates a row that /api/health/cron never reads, because it
  // iterates the job table rather than the collection.
  if (!CRON_JOB_NAMES.includes(job)) {
    console.error(`Refusing to record run for unknown job "${job}" -- not in CRON_JOBS`);
    return;
  }

  try {
    await connectDB();
    const now = new Date();

    const common = {
      lastRunAt: now,
      lastDurationMs: outcome.durationMs,
      lastResult: outcome.result ?? null,
    };

    if (outcome.ok) {
      await JobHeartbeat.updateOne(
        { job },
        {
          // lastError and lastFailureAt are deliberately NOT cleared: a success
          // must not erase the evidence of the failure before it.
          $set: { ...common, lastStatus: 'success', lastSuccessAt: now, consecutiveFailures: 0 },
          $inc: { runCount: 1 },
          $setOnInsert: { job },
        },
        { upsert: true }
      );
      return;
    }

    await JobHeartbeat.updateOne(
      { job },
      {
        $set: {
          ...common,
          lastStatus: 'failure',
          lastFailureAt: now,
          lastError: outcome.error ?? 'unknown error',
        },
        $inc: { runCount: 1, failureCount: 1, consecutiveFailures: 1 },
        $setOnInsert: { job },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error(
      `Failed to record job run for ${job}:`,
      err instanceof Error ? err.message : 'Unknown error'
    );
  }
}

/** Reads a finished response into an outcome without consuming the caller's copy. */
async function readOutcome(res: NextResponse, startedAt: number): Promise<JobRunOutcome> {
  const durationMs = Date.now() - startedAt;
  let body: unknown = null;

  try {
    // clone(), so the body the route returns to wget is left untouched.
    body = await res.clone().json();
  } catch {
    // Not JSON, or an empty body. Not a failure in itself.
  }

  if (res.status >= 400) {
    const error =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    return { ok: false, durationMs, result: body, error };
  }

  return { ok: true, durationMs, result: body };
}

type Handler = (req: NextRequest) => Promise<NextResponse>;

/**
 * Wraps a cron route handler so every run leaves a heartbeat.
 *
 * `job` may be a function of the request, because four routes are scheduled
 * more than once with different parameters and each line needs its own key --
 * otherwise `ingest-snapshots:1d` dies invisibly behind a healthy
 * `ingest-snapshots:1h`.
 *
 * Three rules, each a real failure mode:
 *   - A 401 writes nothing. An unauthenticated probe must not be able to forge
 *     a heartbeat, and a wrong secret is not the job failing. That case is
 *     surfaced by `cronSecretConfigured` on /api/health/cron instead.
 *   - Any status >= 400 is a failure. A 400 from a bad parameter is a job that
 *     is not doing its work.
 *   - The handler's own response object is returned unchanged, never a
 *     reconstruction, so headers and streaming behaviour are untouched.
 */
export function withJobRun(job: string | ((req: NextRequest) => string), handler: Handler): Handler {
  return async function wrapped(req: NextRequest): Promise<NextResponse> {
    const startedAt = Date.now();
    const key = typeof job === 'function' ? job(req) : job;

    let res: NextResponse;
    try {
      res = await handler(req);
    } catch (err) {
      await recordJobRun(key, {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err; // Next's own 500 handling is unchanged.
    }

    if (res.status !== 401) {
      await recordJobRun(key, await readOutcome(res, startedAt));
    }

    return res;
  };
}
