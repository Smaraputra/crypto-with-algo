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

  { job: 'paper-desk', path: '/api/cron/paper-desk', params: {}, schedule: '*/1 * * * *', expectedEverySeconds: MINUTE, method: 'GET' },

  { job: 'resolve-outcomes', path: '/api/cron/resolve-outcomes', params: {}, schedule: '*/15 * * * *', expectedEverySeconds: 15 * MINUTE, method: 'GET' },

  { job: 'ingest-snapshots:1h', path: '/api/cron/ingest-snapshots', params: { interval: '1h' }, schedule: '*/15 * * * *', expectedEverySeconds: 15 * MINUTE, method: 'GET' },
  { job: 'ingest-snapshots:4h', path: '/api/cron/ingest-snapshots', params: { interval: '4h' }, schedule: '0 */4 * * *', expectedEverySeconds: 4 * HOUR, method: 'GET' },
  { job: 'ingest-snapshots:1d', path: '/api/cron/ingest-snapshots', params: { interval: '1d' }, schedule: '0 0 * * *', expectedEverySeconds: DAY, method: 'GET' },

  { job: 'ingest-archive', path: '/api/cron/ingest-archive', params: { days: '3' }, schedule: '0 10 * * *', expectedEverySeconds: DAY, method: 'GET' },
  { job: 'ingest-perp', path: '/api/cron/ingest-perp', params: { days: '3' }, schedule: '30 10 * * *', expectedEverySeconds: DAY, method: 'GET' },
  { job: 'snapshot-portfolios', path: '/api/cron/snapshot-portfolios', params: {}, schedule: '0 0 * * *', expectedEverySeconds: DAY, method: 'GET' },

  { job: 'cross-sectional-signals', path: '/api/cron/cross-sectional-signals', params: {}, schedule: '1 */8 * * *', expectedEverySeconds: 8 * HOUR, method: 'GET' },
  // Same job thirty minutes later: a stored signal is never rewritten, so this only fills a bar the first line could not store.
  { job: 'cross-sectional-signals:retry', path: '/api/cron/cross-sectional-signals', params: { attempt: 'retry' }, schedule: '31 */8 * * *', expectedEverySeconds: 8 * HOUR, method: 'GET' },
  // 01:05, 09:05, 17:05 UTC: the first 1h fill bar after each 8h close has closed.
  { job: 'cross-sectional-paper', path: '/api/cron/cross-sectional-paper', params: {}, schedule: '5 1-23/8 * * *', expectedEverySeconds: 8 * HOUR, method: 'GET' },

  // Minute 3 is two minutes after the rv-v1 signal at minute 1.
  { job: 'lab-signals:8h', path: '/api/cron/lab-signals', params: { cadence: '8h' }, schedule: '3 */8 * * *', expectedEverySeconds: 8 * HOUR, method: 'GET' },
  // Minute 8 is the final attempt before T + 10 minutes.
  { job: 'lab-signals:8h:retry', path: '/api/cron/lab-signals', params: { cadence: '8h', attempt: 'retry' }, schedule: '8 */8 * * *', expectedEverySeconds: 8 * HOUR, method: 'GET' },
  // Scores L2 within D of each 5m to 1d close.
  { job: 'lab-signals:fast', path: '/api/cron/lab-signals', params: { cadence: 'fast' }, schedule: '*/1 * * * *', expectedEverySeconds: MINUTE, method: 'GET' },
  // Grades every bar whose return window has closed.
  { job: 'lab-grade', path: '/api/cron/lab-grade', params: {}, schedule: '20 * * * *', expectedEverySeconds: HOUR, method: 'GET' },
] as const;

/**
 * A job whose health is read from its own records rather than from a heartbeat.
 *
 * Two reasons a job lands here. Either it does not run in the cron container at
 * all, so `docker/crontab.template` cannot see it and neither can
 * `withJobRun`, or it is fire-and-forget, so the moment its route returns tells
 * you nothing. The table is empty since the LLM panel, its only entry, was
 * retired on 2026-10-16.
 */
export interface DerivedJobSpec {
  job: string;
  schedule: string;
  expectedEverySeconds: number;
  /** Where `lastSuccessAt` comes from, since there is no heartbeat row. */
  derivedFrom: string;
}

export const DERIVED_JOBS: readonly DerivedJobSpec[] = [] as const;

/**
 * A long-running process, not a crontab line, that writes its own heartbeat
 * row through `recordJobRun` on a fixed cadence.
 *
 * WHY A THIRD TABLE: a service is in neither of the other two. It has no line
 * in `docker/crontab.template`, so putting it in `CRON_JOBS` would break the
 * bijection test, and it does write a heartbeat row, so it is not derived from
 * some other record the way `DERIVED_JOBS` are. `/api/health/cron` classifies
 * it from its row exactly like a cron job: `expectedEverySeconds` is the
 * heartbeat cadence, so a process that died, hung or lost Mongo goes overdue
 * after the same grace a 1-minute cron job gets, and a process that is up but
 * not doing its work reports `failure` and reads as failing.
 */
export interface ServiceJobSpec {
  job: string;
  /** Not a crontab expression; shown on /api/health/cron so a reader knows why. */
  schedule: string;
  /** The heartbeat cadence. */
  expectedEverySeconds: number;
  /** Where the process runs, since no crontab line says so. */
  runsIn: string;
}

export const SERVICE_JOBS: readonly ServiceJobSpec[] = [
  {
    job: 'market-recorder',
    schedule: 'continuous, heartbeat every minute',
    expectedEverySeconds: MINUTE,
    runsIn: 'the recorder service in docker-compose.server.yml (scripts/ops/market-recorder.ts)',
  },
] as const;

export const CRON_JOB_NAMES: readonly string[] = CRON_JOBS.map((j) => j.job);

/**
 * Every key allowed a heartbeat row: the crontab lines plus the services.
 * `recordJobRun` and the `JobHeartbeat` enum both check against THIS, so a
 * typo'd key still cannot create a row that no health check reads.
 */
export const HEARTBEAT_JOB_NAMES: readonly string[] = [
  ...CRON_JOB_NAMES,
  ...SERVICE_JOBS.map((j) => j.job),
];

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

  // A fixed minute every N hours inside an offset range, e.g. `5 1-23/8`.
  const offsetHours = /^\d+-\d+\/(\d+)$/.exec(hour);
  if (offsetHours) return Number(offsetHours[1]) * HOUR;

  // A fixed minute of a fixed hour, i.e. once a day.
  if (/^\d+$/.test(hour)) return DAY;

  throw new Error(`Unsupported cron expression (hour field): ${expression}`);
}
