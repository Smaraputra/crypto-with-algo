import mongoose, { Schema, type Document } from 'mongoose';

import { CRON_JOB_NAMES } from '@/lib/cron-jobs';

/**
 * One row per scheduled job, holding only its latest state.
 *
 * WHY A SEPARATE COLLECTION and not a widened `CronRun`:
 *
 * 1. It would break a live page. `/api/admin/cron-runs` does
 *    `CronRun.find().sort({scheduledAt:-1}).limit(50)` with NO type filter, and
 *    `CronHistory.tsx` renders the result as an optimization job tree. Widening
 *    the enum means the next fifty rows are `sync-candles:1m` heartbeats and
 *    the optimization history vanishes from the UI on day one.
 * 2. Retention conflicts. The three `monthly_optimization` documents are
 *    records to keep permanently; heartbeats at this cadence would need a TTL.
 * 3. `CronRun` is optimization-shaped. Its `type` is the literal
 *    `'monthly_optimization'`, `scheduledAt` is required, and `jobs[]` carries
 *    `{tradingStyle, jobId, activated, activationReason, gateReason}` — none of
 *    which means anything for `sync-candles`.
 *
 * WHY LAST-STATE AND NOT A RUN LOG: `compute-signals?style=scalping` and
 * `sync-candles?intervals=1m` each fire every minute, so a document per run is
 * ~1,440 rows/day/job and would need a TTL to stay bounded. The question this
 * exists to answer -- "is everything still running?" -- needs only the latest
 * state, so every run upserts the same row, the collection stays at one
 * document per job forever, and the answer is a single unfiltered `find()`.
 *
 * This is deliberately NOT alerting. It makes state inspectable and truthful;
 * a human or `/api/health/cron` reads it. Nothing here sends anything anywhere.
 */
export interface IJobHeartbeat extends Document {
  /** A `CronJobSpec.job` key: route slug plus the parameter distinguishing its crontab line. */
  job: string;
  /** Every completed attempt, success or failure. */
  lastRunAt: Date;
  lastDurationMs: number;
  lastStatus: 'success' | 'failure';
  /**
   * The route's own response body, so a run's counts are inspectable without
   * reading `/var/log/cron.log` (truncated nightly, carries the cron secret,
   * read by nobody). Mixed because every route answers a different shape.
   */
  lastResult: unknown;
  /** The staleness clock reads THIS, never `lastRunAt`. See cron-health.ts. */
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  /** Kept across later successes, so a success cannot erase the evidence of the failure before it. */
  lastError: string | null;
  /** Reset to 0 on success. A job failing for a while should be the first thing a glance surfaces. */
  consecutiveFailures: number;
  runCount: number;
  failureCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const jobHeartbeatSchema = new Schema<IJobHeartbeat>(
  {
    job: { type: String, required: true, unique: true, enum: CRON_JOB_NAMES },
    lastRunAt: { type: Date, required: true },
    lastDurationMs: { type: Number, required: true },
    lastStatus: { type: String, required: true, enum: ['success', 'failure'] },
    // Schema.Types.Mixed, not [Mixed]: the array wrapper causes a generic type
    // mismatch, per the note in historical-snapshot.ts.
    lastResult: { type: Schema.Types.Mixed, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastFailureAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    consecutiveFailures: { type: Number, required: true, default: 0 },
    runCount: { type: Number, required: true, default: 0 },
    failureCount: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

// No TTL. A row that stops being updated is exactly the signal this collection
// carries, so expiring it would delete the evidence of the outage.

export const JobHeartbeat =
  mongoose.models.JobHeartbeat ||
  mongoose.model<IJobHeartbeat>('JobHeartbeat', jobHeartbeatSchema);
