// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  runLabSignals8h: vi.fn(),
  runLabSignalsFast: vi.fn(),
  jobKeys: [] as string[],
}));

vi.mock('@/lib/cron-auth', () => ({ verifyCronSecret: (...a: unknown[]) => mocks.verify(...a) }));
vi.mock('@/lib/signals/lab/job-signals', () => ({
  runLabSignals8h: (...a: unknown[]) => mocks.runLabSignals8h(...a),
  runLabSignalsFast: (...a: unknown[]) => mocks.runLabSignalsFast(...a),
}));
// Pass the handler through, but record the heartbeat key the route asks for
vi.mock('@/lib/job-run', () => ({
  withJobRun:
    (job: string | ((req: NextRequest) => string), handler: (req: NextRequest) => Promise<Response>) =>
    (req: NextRequest) => {
      mocks.jobKeys.push(typeof job === 'function' ? job(req) : job);
      return handler(req);
    },
}));

function request(query = ''): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000/api/cron/lab-signals${query}`));
}

const OK_8H = {
  success: true,
  written: [{ hypothesis: 'L1-8h', barClose: 1_790_121_600_000, late: false }],
  waiting: [],
  errors: [],
};

const OK_FAST = {
  success: true,
  written: [{ hypothesis: 'L2-5m', barClose: 1_790_121_600_000, late: false }],
  waiting: [],
  errors: [],
};

describe('GET /api/cron/lab-signals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jobKeys.length = 0;
    mocks.verify.mockReturnValue(true);
    mocks.runLabSignals8h.mockResolvedValue(OK_8H);
    mocks.runLabSignalsFast.mockResolvedValue(OK_FAST);
  });

  it('returns 401 and never runs a job without the cron secret', async () => {
    mocks.verify.mockReturnValue(false);
    const { GET } = await import('./route');
    const res = await GET(request('?cadence=8h'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.runLabSignals8h).not.toHaveBeenCalled();
    expect(mocks.runLabSignalsFast).not.toHaveBeenCalled();
  });

  it('calls runLabSignals8h with timestamp, undefined deps and { final: false } on ?cadence=8h', async () => {
    const before = Date.now();
    const { GET } = await import('./route');
    const res = await GET(request('?cadence=8h'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK_8H);
    expect(mocks.runLabSignals8h).toHaveBeenCalledTimes(1);
    const [now, deps, opts] = mocks.runLabSignals8h.mock.calls[0];
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(deps).toBeUndefined();
    expect(opts).toEqual({ final: false });
    expect(mocks.jobKeys).toEqual(['lab-signals:8h']);
  });

  it('passes { final: true } and records lab-signals:8h:retry on ?cadence=8h&attempt=retry', async () => {
    const before = Date.now();
    const { GET } = await import('./route');
    const res = await GET(request('?cadence=8h&attempt=retry'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK_8H);
    expect(mocks.runLabSignals8h).toHaveBeenCalledTimes(1);
    const [now, deps, opts] = mocks.runLabSignals8h.mock.calls[0];
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(deps).toBeUndefined();
    expect(opts).toEqual({ final: true });
    expect(mocks.jobKeys).toEqual(['lab-signals:8h:retry']);
  });

  it('calls runLabSignalsFast and records lab-signals:fast on ?cadence=fast', async () => {
    const before = Date.now();
    const { GET } = await import('./route');
    const res = await GET(request('?cadence=fast'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK_FAST);
    expect(mocks.runLabSignalsFast).toHaveBeenCalledTimes(1);
    const [now] = mocks.runLabSignalsFast.mock.calls[0];
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(mocks.jobKeys).toEqual(['lab-signals:fast']);
  });

  it('returns 500 when the report has success: false', async () => {
    const failure = {
      success: false,
      written: [],
      waiting: [],
      errors: ['fetch failed'],
    };
    mocks.runLabSignals8h.mockResolvedValue(failure);
    const { GET } = await import('./route');
    const res = await GET(request('?cadence=8h'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(failure);
  });

  it('returns 500 when the job throws', async () => {
    mocks.runLabSignals8h.mockRejectedValue(new Error('mongo down'));
    const { GET } = await import('./route');
    const res = await GET(request('?cadence=8h'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'mongo down' });
  });

  it('returns 400 and calls no job on missing or bad cadence', async () => {
    const { GET } = await import('./route');
    const resMissing = await GET(request());
    expect(resMissing.status).toBe(400);
    expect(await resMissing.json()).toEqual({ error: 'cadence must be 8h or fast' });

    const resBad = await GET(request('?cadence=1h'));
    expect(resBad.status).toBe(400);
    expect(await resBad.json()).toEqual({ error: 'cadence must be 8h or fast' });

    expect(mocks.runLabSignals8h).not.toHaveBeenCalled();
    expect(mocks.runLabSignalsFast).not.toHaveBeenCalled();
    expect(mocks.jobKeys).toEqual(['lab-signals:invalid', 'lab-signals:invalid']);
  });

  it('matches the three CRON_JOBS entries for /api/cron/lab-signals', async () => {
    const { CRON_JOBS } = await import('@/lib/cron-jobs');
    expect(CRON_JOBS.find((j) => j.job === 'lab-signals:8h')).toMatchObject({
      path: '/api/cron/lab-signals',
      params: { cadence: '8h' },
      schedule: '3 */8 * * *',
      expectedEverySeconds: 8 * 3600,
      method: 'GET',
    });
    expect(CRON_JOBS.find((j) => j.job === 'lab-signals:8h:retry')).toMatchObject({
      path: '/api/cron/lab-signals',
      params: { cadence: '8h', attempt: 'retry' },
      schedule: '8 */8 * * *',
      expectedEverySeconds: 8 * 3600,
      method: 'GET',
    });
    expect(CRON_JOBS.find((j) => j.job === 'lab-signals:fast')).toMatchObject({
      path: '/api/cron/lab-signals',
      params: { cadence: 'fast' },
      schedule: '*/1 * * * *',
      expectedEverySeconds: 60,
      method: 'GET',
    });
  });
});
