import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { connectDB } from '@/lib/mongodb';
import { DERIVED_JOBS, HEARTBEAT_JOBS } from '@/lib/cron-jobs';
import { classifyJob, isAllHealthy, summarize, type JobHealth, type JobState } from '@/lib/cron-health';
import { JobHeartbeat, type IJobHeartbeat } from '@/lib/models/job-heartbeat';
import { CronRun } from '@/lib/models/cron-run';
import { LlmCall } from '@/lib/models/llm-call';

export const dynamic = 'force-dynamic';

/**
 * One call that answers "is everything still running?".
 *
 * WHY NOT AN EXTENSION OF /api/health: that route is the container
 * HEALTHCHECK target in the Dockerfile. If it went 503 because a cron job is
 * late, the app container would go unhealthy and anything keyed on
 * `service_healthy` would restart a perfectly good web app because a different
 * container's scheduler is behind. Liveness and freshness must not share a
 * status code, and /api/health must stay the cheap readyState check it is.
 *
 * This is inspection, not alerting: nothing here notifies anybody.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = Date.now();

  try {
    await connectDB();

    const heartbeats = (await JobHeartbeat.find({}).lean()) as unknown as IJobHeartbeat[];
    const byJob = new Map(heartbeats.map((h) => [h.job, h]));

    // The earliest moment this deployment could have recorded a run. A job with
    // no heartbeat is only a fault once a full interval has passed since then;
    // before that its silence means the container was recreated, not that the
    // job is broken. Heartbeats live in Mongo and survive a recreate, so the
    // oldest one is the honest anchor rather than process start.
    const observedSinceMs = heartbeats.reduce<number | null>((oldest, heartbeat) => {
      const created = heartbeat.createdAt?.getTime();
      if (created == null || !Number.isFinite(created)) return oldest;
      return oldest == null || created < oldest ? created : oldest;
    }, null);

    const jobs: JobHealth[] = HEARTBEAT_JOBS.map((spec) =>
      classifyJob(spec, (byJob.get(spec.job) as JobState | undefined) ?? null, now, observedSinceMs)
    );

    for (const spec of DERIVED_JOBS) {
      jobs.push(classifyJob(spec, await derivedState(spec.job), now, observedSinceMs));
    }

    const summary = summarize(jobs);
    const healthy = isAllHealthy(summary);

    return NextResponse.json(
      {
        status: healthy ? 'ok' : 'degraded',
        checkedAt: new Date(now).toISOString(),
        // Distinguishes "nothing is running" from "nothing can authenticate":
        // an unset CRON_SECRET makes every crontab line send `Bearer ` and
        // every job 401 forever, which otherwise looks identical to silence.
        cronSecretConfigured: Boolean(process.env.CRON_SECRET),
        summary,
        jobs: jobs.sort((a, b) => a.job.localeCompare(b.job)),
      },
      { status: healthy ? 200 : 503 }
    );
  } catch (error) {
    console.error('Error building cron health:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * State for a job with no heartbeat row, read from whatever record it does
 * leave behind. See `DERIVED_JOBS` for why each one is here.
 */
async function derivedState(job: string): Promise<JobState | null> {
  if (job === 'llm-panel') {
    // The panel posts calls from the VPS; a call landing IS the run succeeding.
    // This is the outage that motivated the whole heartbeat layer, and it needs
    // no write path at all.
    const latest = await LlmCall.findOne({}).sort({ createdAt: -1 }).select('createdAt').lean();
    const createdAt = (latest as { createdAt?: Date } | null)?.createdAt ?? null;
    return createdAt ? { lastRunAt: createdAt, lastSuccessAt: createdAt, lastStatus: 'success' } : null;
  }

  if (job === 'monthly-optimization') {
    const latest = (await CronRun.findOne({ type: 'monthly_optimization' })
      .sort({ scheduledAt: -1 })
      .lean()) as { status?: string; completedAt?: Date; startedAt?: Date; error?: string } | null;
    if (!latest) return null;

    const ranAt = latest.completedAt ?? latest.startedAt ?? null;
    const succeeded = latest.status === 'completed';
    return {
      lastRunAt: ranAt,
      lastSuccessAt: succeeded ? ranAt : null,
      lastFailureAt: succeeded ? null : ranAt,
      lastStatus: succeeded ? 'success' : 'failure',
      lastError: succeeded ? null : (latest.error ?? `status ${latest.status}`),
    };
  }

  return null;
}
