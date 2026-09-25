// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { GET } from './route';
import { DERIVED_JOBS, HEARTBEAT_JOBS } from '@/lib/cron-jobs';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

const mocks = vi.hoisted(() => ({
  heartbeatFind: vi.fn(),
  cronRunFindOne: vi.fn(),
  llmCallFindOne: vi.fn(),
}));

vi.mock('@/lib/models/job-heartbeat', () => ({
  JobHeartbeat: { find: mocks.heartbeatFind },
}));
vi.mock('@/lib/models/cron-run', () => ({
  CronRun: { findOne: mocks.cronRunFindOne },
}));
vi.mock('@/lib/models/llm-call', () => ({
  LlmCall: { findOne: mocks.llmCallFindOne },
}));

const SECRET = 'test-secret';

function request(auth = `Bearer ${SECRET}`): NextRequest {
  return new NextRequest('http://localhost:3000/api/health/cron', {
    headers: auth ? { authorization: auth } : {},
  });
}

/** Mongoose chain stubs: find().lean() and findOne().sort().select().lean(). */
function findReturning(docs: unknown[]) {
  return { lean: vi.fn().mockResolvedValue(docs) };
}
function findOneReturning(doc: unknown) {
  return {
    sort: () => ({
      select: () => ({ lean: vi.fn().mockResolvedValue(doc) }),
      lean: vi.fn().mockResolvedValue(doc),
    }),
  };
}

const now = Date.now();
const agoSeconds = (s: number) => new Date(now - s * 1000);

/** A fresh heartbeat for every wrapped job, so the baseline is all-healthy. */
function allHealthyHeartbeats() {
  return HEARTBEAT_JOBS.map((spec) => ({
    job: spec.job,
    lastRunAt: new Date(now),
    lastSuccessAt: new Date(now),
    lastStatus: 'success',
    lastDurationMs: 10,
    lastResult: { ok: true },
    consecutiveFailures: 0,
    // The observation anchor: how far back this deployment could have seen a
    // run at all. Old enough here that nothing is excused as pending.
    createdAt: new Date(now - 30 * 24 * 3600 * 1000),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  mocks.heartbeatFind.mockReturnValue(findReturning(allHealthyHeartbeats()));
  mocks.llmCallFindOne.mockReturnValue(findOneReturning({ createdAt: new Date(now) }));
  mocks.cronRunFindOne.mockReturnValue(
    findOneReturning({ status: 'completed', completedAt: new Date(now), scheduledAt: new Date(now) })
  );
});

describe('GET /api/health/cron', () => {
  it('rejects a request without the cron secret', async () => {
    const res = await GET(request(''));

    expect(res.status).toBe(401);
    expect(mocks.heartbeatFind).not.toHaveBeenCalled();
  });

  it('returns 200 and ok when every job is healthy', async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.summary).toEqual({
      healthy: HEARTBEAT_JOBS.length + DERIVED_JOBS.length,
      overdue: 0,
      failing: 0,
      never_ran: 0,
      pending: 0,
    });
  });

  it('reports every wrapped job plus every derived job', async () => {
    const body = await (await GET(request())).json();

    expect(body.jobs).toHaveLength(HEARTBEAT_JOBS.length + DERIVED_JOBS.length);
    for (const spec of HEARTBEAT_JOBS) {
      expect(body.jobs.some((j: { job: string }) => j.job === spec.job)).toBe(true);
    }
    expect(body.jobs.some((j: { job: string }) => j.job === 'llm-panel')).toBe(true);
  });

  it('stays 200 when a daily job has no heartbeat but recording only just began', async () => {
    // The real outage shape: the cron container was recreated an hour ago, so a
    // daily job has had no opportunity to run. Its absence is not a fault.
    const beats = allHealthyHeartbeats()
      .filter((b) => b.job !== 'ingest-archive')
      .map((b) => ({ ...b, createdAt: new Date(now - 3600 * 1000) }));
    mocks.heartbeatFind.mockReturnValue(findReturning(beats));

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.summary.pending).toBeGreaterThanOrEqual(1);
    expect(body.summary.never_ran).toBe(0);
    expect(body.jobs.find((j: { job: string }) => j.job === 'ingest-archive').state).toBe('pending');
  });

  it('returns 503 and degraded when a job has never run', async () => {
    mocks.heartbeatFind.mockReturnValue(findReturning([]));

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.summary.never_ran).toBe(HEARTBEAT_JOBS.length);
  });

  it('returns 503 when one job is failing', async () => {
    const beats = allHealthyHeartbeats();
    beats[0] = { ...beats[0], lastStatus: 'failure', lastError: 'boom' } as (typeof beats)[number];
    mocks.heartbeatFind.mockReturnValue(findReturning(beats));

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.summary.failing).toBe(1);
    expect(body.jobs.find((j: { job: string }) => j.job === beats[0].job).lastError).toBe('boom');
  });

  it('flags a dead LLM panel as overdue from the newest call alone', async () => {
    // The incident this whole layer was built after: the panel stopped for
    // three days and nothing noticed. It writes no heartbeat -- it runs from
    // the VPS host crontab -- so its state is read from the record it leaves.
    mocks.llmCallFindOne.mockReturnValue(findOneReturning({ createdAt: agoSeconds(3 * 86400) }));

    const body = await (await GET(request())).json();
    const panel = body.jobs.find((j: { job: string }) => j.job === 'llm-panel');

    expect(panel.state).toBe('overdue');
    expect(panel.sinceSuccessSeconds).toBeGreaterThan(86400);
  });

  it('reports the panel as never_ran when no call exists at all', async () => {
    mocks.llmCallFindOne.mockReturnValue(findOneReturning(null));

    const body = await (await GET(request())).json();

    expect(body.jobs.find((j: { job: string }) => j.job === 'llm-panel').state).toBe('never_ran');
  });

  it('derives a failed optimization run rather than trusting its fire-and-forget 200', async () => {
    mocks.cronRunFindOne.mockReturnValue(
      findOneReturning({ status: 'failed', completedAt: new Date(now), error: 'orchestrator threw' })
    );

    const body = await (await GET(request())).json();
    const job = body.jobs.find((j: { job: string }) => j.job === 'monthly-optimization');

    expect(job.state).toBe('failing');
    expect(job.lastError).toBe('orchestrator threw');
  });

  it('reports whether the cron secret is configured at all', async () => {
    const configured = await (await GET(request())).json();
    expect(configured.cronSecretConfigured).toBe(true);

    // An unset secret 401s every job forever, which otherwise looks exactly
    // like cron not running. The flag separates the two.
    delete process.env.CRON_SECRET;
    const res = await GET(request());
    expect(res.status).toBe(401);
  });

  it('returns 500 when the heartbeat read throws', async () => {
    mocks.heartbeatFind.mockImplementation(() => {
      throw new Error('mongo down');
    });

    const res = await GET(request());

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Internal server error');
  });
});
