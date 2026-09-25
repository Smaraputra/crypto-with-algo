/**
 * The scheduled-job table: one entry per crontab LINE, not per route.
 *
 * WHY PER LINE: four routes are scheduled more than once with different
 * parameters. `sync-candles` runs three times (standard, 1m, 5m) and
 * `compute-signals` four times, one per trading style.
 * A heartbeat keyed on the route alone would let `ingest-snapshots:1d` die
 * invisibly behind a healthy `ingest-snapshots:1h`, and
 * `compute-signals:position_trading` (hourly) die behind
 * `compute-signals:scalping` firing every minute. The key is therefore the
 * route plus whatever parameter distinguishes the line.
 *
 * WHY THIS FILE IS THE SOURCE OF TRUTH and not `docker/crontab.template`:
 * that file is bind-mounted into the cron container only and is not in the app
 * image, so the running app cannot read it. Copying it in to parse at runtime
 * would couple the Next build to `docker/`.
 *
 * The two are kept in step by `cron-jobs.test.ts`, which reads the template
 * off disk and asserts a bijection with this table plus a verbatim schedule
 * match. They can still diverge, but only through a failing test.
 *
 * KNOWN LIMIT: the test pins this table against the template in the REPO. The
 * template is bind-mounted read-only and `docker compose up -d --build` does
 * not recreate the cron container, so a deployed container can still be
 * running an older crontab while the test is green. After any change here run
 * `docker compose -f docker-compose.server.yml up -d --force-recreate cron`.
 */

export interface CronJobSpec {
  /** Heartbeat key. Route slug, plus the distinguishing parameter where a route has several lines. */
  job: string;
  path: string;
  /** The query parameters that identify this line, empty when the line takes none. */
  params: Record<string, string>;
  /** The crontab expression, verbatim apart from whitespace. */
  schedule: string;
  /** Nominal gap between runs, derived from `schedule` and checked against it by the test. */
  expectedEverySeconds: number;
  method: 'GET' | 'POST';
  /**
   * Set when the job must not be wrapped by `withJobRun`, with the reason.
   * A fire-and-forget route returns before its work is done, so a wrapper
   * would record success at the moment the work STARTS, which is a lie.
   */
  noHeartbeat?: string;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const CRON_JOBS: readonly CronJobSpec[] = [
  { job: 'check-alerts', path: '/api/cron/check-alerts', params: {}, schedule: '*/5 * * * *', expectedEverySeconds: 5 * MINUTE, method: 'GET' },

  { job: 'sync-candles:standard', path: '/api/cron/sync-candles', params: {}, schedule: '*/15 * * * *', expectedEverySeconds: 15 * MINUTE, method: 'GET' },
  { job: 'sync-candles:1m', path: '/api/cron/sync-candles', params: { intervals: '1m' }, schedule: '*/1 * * * *', expectedEverySeconds: MINUTE, method: 'GET' },
  { job: 'sync-candles:5m', path: '/api/cron/sync-candles', params: { intervals: '5m' }, schedule: '*/5 * * * *', expectedEverySeconds: 5 * MINUTE, method: 'GET' },

  { job: 'compute-signals:scalping', path: '/api/cron/compute-signals', params: { style: 'scalping' }, schedule: '*/1 * * * *', expectedEverySeconds: MINUTE, method: 'GET' },
  { job: 'compute-signals:day_trading', path: '/api/cron/compute-signals', params: { style: 'day_trading' }, schedule: '1-59/5 * * * *', expectedEverySeconds: 5 * MINUTE, method: 'GET' },
  { job: 'compute-signals:swing_trading', path: '/api/cron/compute-signals', params: { style: 'swing_trading' }, schedule: '1-59/15 * * * *', expectedEverySeconds: 15 * MINUTE, method: 'GET' },
  { job: 'compute-signals:position_trading', path: '/api/cron/compute-signals', params: { style: 'position_trading' }, schedule: '1 * * * *', expectedEverySeconds: HOUR, method: 'GET' },

  { job: 'resolve-outcomes', path: '/api/cron/resolve-outcomes', params: {}, schedule: '*/15 * * * *', expectedEverySeconds: 15 * MINUTE, method: 'GET' },

  { job: 'ingest-snapshots:1h', path: '/api/cron/ingest-snapshots', params: { interval: '1h' }, schedule: '*/15 * * * *', expectedEverySeconds: 15 * MINUTE, method: 'GET' },
  { job: 'ingest-snapshots:4h', path: '/api/cron/ingest-snapshots', params: { interval: '4h' }, schedule: '0 */4 * * *', expectedEverySeconds: 4 * HOUR, method: 'GET' },
  { job: 'ingest-snapshots:1d', path: '/api/cron/ingest-snapshots', params: { interval: '1d' }, schedule: '0 0 * * *', expectedEverySeconds: DAY, method: 'GET' },

  { job: 'ingest-archive', path: '/api/cron/ingest-archive', params: { days: '3' }, schedule: '0 10 * * *', expectedEverySeconds: DAY, method: 'GET' },
  { job: 'ingest-perp', path: '/api/cron/ingest-perp', params: { days: '3' }, schedule: '30 10 * * *', expectedEverySeconds: DAY, method: 'GET' },
  { job: 'snapshot-portfolios', path: '/api/cron/snapshot-portfolios', params: {}, schedule: '0 0 * * *', expectedEverySeconds: DAY, method: 'GET' },

  {
    job: 'monthly-optimization',
    path: '/api/cron/monthly-optimization',
    params: {},
    // Worst-case gap between the 1st of two consecutive months.
    schedule: '0 0 1 * *',
    expectedEverySeconds: 31 * DAY,
    method: 'POST',
    noHeartbeat:
      'fire-and-forget: the route returns 200 immediately and runs the orchestrator in the ' +
      'background, so a wrapper would record success at the moment the work starts. Its health ' +
      'is derived from the newest CronRun document instead.',
  },
] as const;

/**
 * A job whose health is read from its own records rather than from a heartbeat.
 *
 * Two reasons a job lands here. Either it does not run in the cron container at
 * all -- the LLM panel is on the VPS HOST crontab and never calls this app, so
 * `docker/crontab.template` cannot see it and neither can `withJobRun` -- or it
 * is fire-and-forget, so the moment its route returns tells you nothing.
 */
export interface DerivedJobSpec {
  job: string;
  schedule: string;
  expectedEverySeconds: number;
  /** Where `lastSuccessAt` comes from, since there is no heartbeat row. */
  derivedFrom: string;
}

export const DERIVED_JOBS: readonly DerivedJobSpec[] = [
  {
    job: 'llm-panel',
    // VPS host crontab, under CRON_TZ=UTC. Deliberately absent from
    // docker/crontab.template, so the drift test must not look for it.
    schedule: '7 */2 * * *',
    expectedEverySeconds: 2 * HOUR,
    derivedFrom: 'newest LlmCall.createdAt',
  },
  {
    job: 'monthly-optimization',
    schedule: '0 0 1 * *',
    expectedEverySeconds: 31 * DAY,
    derivedFrom: 'newest CronRun of type monthly_optimization',
  },
] as const;

export const CRON_JOB_NAMES: readonly string[] = CRON_JOBS.map((j) => j.job);

/** Jobs that `withJobRun` wraps, i.e. everything whose completion the response actually reports. */
export const HEARTBEAT_JOBS: readonly CronJobSpec[] = CRON_JOBS.filter((j) => !j.noHeartbeat);

export function cronJob(job: string): CronJobSpec | undefined {
  return CRON_JOBS.find((j) => j.job === job);
}

/**
 * Nominal seconds between runs of a crontab expression.
 *
 * Deliberately supports ONLY the six forms the template actually uses and
 * throws on anything else, so a new line in an unrecognised shape fails the
 * drift test loudly instead of being silently mis-measured (and therefore
 * never reported overdue).
 */
export function secondsBetweenRuns(expression: string): number {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Unsupported cron expression (expected 5 fields): ${expression}`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  if (month !== '*' || dayOfWeek !== '*') {
    throw new Error(`Unsupported cron expression (month/weekday restrictions): ${expression}`);
  }

  // Monthly: a fixed day of the month. The gap is a month, taken at its longest.
  if (dayOfMonth !== '*') {
    if (!/^\d+$/.test(dayOfMonth) || !/^\d+$/.test(minute) || !/^\d+$/.test(hour)) {
      throw new Error(`Unsupported cron expression (monthly form): ${expression}`);
    }
    return 31 * DAY;
  }

  // Every N minutes, in either the `*/N` or the offset `1-59/N` form.
  const everyNMinutes = /^(?:\*|\d+-\d+)\/(\d+)$/.exec(minute);
  if (everyNMinutes) {
    if (hour !== '*') {
      throw new Error(`Unsupported cron expression (stepped minute with restricted hour): ${expression}`);
    }
    return Number(everyNMinutes[1]) * MINUTE;
  }

  if (!/^\d+$/.test(minute)) {
    throw new Error(`Unsupported cron expression (minute field): ${expression}`);
  }

  // A fixed minute of every hour.
  if (hour === '*') return HOUR;

  // A fixed minute every N hours.
  const everyNHours = /^\*\/(\d+)$/.exec(hour);
  if (everyNHours) return Number(everyNHours[1]) * HOUR;

  // A fixed minute of a fixed hour, i.e. once a day.
  if (/^\d+$/.test(hour)) return DAY;

  throw new Error(`Unsupported cron expression (hour field): ${expression}`);
}
