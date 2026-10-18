// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  runLabSignals8h: vi.fn(),
  runLabSignalsFast: vi.fn(),
  runLabV2Weekly: vi.fn(),
  runLabV2Daily: vi.fn(),
  jobKeys: [] as string[],
}));

vi.mock('@/lib/cron-auth', () => ({ verifyCronSecret: (...a: unknown[]) => mocks.verify(...a) }));
vi.mock('@/lib/signals/lab/job-signals', () => ({
  runLabSignals8h: (...a: unknown[]) => mocks.runLabSignals8h(...a),
  runLabSignalsFast: (...a: unknown[]) => mocks.runLabSignalsFast(...a),
}));
vi.mock('@/lib/signals/lab/job-signals-v2', () => ({
  runLabV2Weekly: (...a: unknown[]) => mocks.runLabV2Weekly(...a),
  runLabV2Daily: (...a: unknown[]) => mocks.runLabV2Daily(...a),
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

const OK_V2_1W = {
  success: true,
  written: [{ hypothesis: 'N2-1w', barClose: 1_790_121_600_000, late: false }],
  waiting: [],
  errors: [],
};

const OK_V2_1D = {
  success: true,
  written: [{ hypothesis: 'N3-1d', barClose: 1_790_121_600_000, late: false }],
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
    mocks.runLabV2Weekly.mockResolvedValue(OK_V2_1W);
    mocks.runLabV2Daily.mockResolvedValue(OK_V2_1D);
  });

  it('returns 401 and never runs a job without the cron secret', async () => {
    mocks.verify.mockReturnValue(false);
    const { GET } = await import('./route');
    const res8h = await GET(request('?cadence=8h'));
    expect(res8h.status).toBe(401);
    expect(await res8h.json()).toEqual({ error: 'Unauthorized' });

    const resWeekly = await GET(request('?cadence=v2-1w'));
    expect(resWeekly.status).toBe(401);
    expect(await resWeekly.json()).toEqual({ error: 'Unauthorized' });

    const resDaily = await GET(request('?cadence=v2-1d'));
    expect(resDaily.status).toBe(401);
    expect(await resDaily.json()).toEqual({ error: 'Unauthorized' });

    expect(mocks.runLabSignals8h).not.toHaveBeenCalled();
    expect(mocks.runLabSignalsFast).not.toHaveBeenCalled();
    expect(mocks.runLabV2Weekly).not.toHaveBeenCalled();
    expect(mocks.runLabV2Daily).not.toHaveBeenCalled();
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

  it('calls runLabV2Weekly with timestamp, undefined deps and { final: false } on ?cadence=v2-1w', async () => {
    const before = Date.now();
    const { GET } = await import('./route');
    const res = await GET(request('?cadence=v2-1w'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK_V2_1W);
    expect(mocks.runLabV2Weekly).toHaveBeenCalledTimes(1);
    const [now, deps, opts] = mocks.runLabV2Weekly.mock.calls[0];
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(deps).toBeUndefined();
    expect(opts).toEqual({ final: false });
    expect(mocks.jobKeys).toEqual(['lab-v2-signals:1w']);
  });

  it('passes { final: true } and records lab-v2-signals:1w:retry on ?cadence=v2-1w&attempt=retry', async () => {
    const before = Date.now();
    const { GET } = await import('./route');
    const res = await GET(request('?cadence=v2-1w&attempt=retry'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK_V2_1W);
    expect(mocks.runLabV2Weekly).toHaveBeenCalledTimes(1);
    const [now, deps, opts] = mocks.runLabV2Weekly.mock.calls[0];
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(deps).toBeUndefined();
    expect(opts).toEqual({ final: true });
    expect(mocks.jobKeys).toEqual(['lab-v2-signals:1w:retry']);
  });

  it('calls runLabV2Daily with timestamp, undefined deps and { final: false } on ?cadence=v2-1d', async () => {
    const before = Date.now();
    const { GET } = await import('./route');
    const res = await GET(request('?cadence=v2-1d'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK_V2_1D);
    expect(mocks.runLabV2Daily).toHaveBeenCalledTimes(1);
    const [now, deps, opts] = mocks.runLabV2Daily.mock.calls[0];
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(deps).toBeUndefined();
    expect(opts).toEqual({ final: false });
    expect(mocks.jobKeys).toEqual(['lab-v2-signals:1d']);
  });

  it('passes { final: true } and records lab-v2-signals:1d:retry on ?cadence=v2-1d&attempt=retry', async () => {
    const before = Date.now();
    const { GET } = await import('./route');
    const res = await GET(request('?cadence=v2-1d&attempt=retry'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK_V2_1D);
    expect(mocks.runLabV2Daily).toHaveBeenCalledTimes(1);
    const [now, deps, opts] = mocks.runLabV2Daily.mock.calls[0];
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(deps).toBeUndefined();
    expect(opts).toEqual({ final: true });
    expect(mocks.jobKeys).toEqual(['lab-v2-signals:1d:retry']);
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
    expect(await resMissing.json()).toEqual({ error: 'cadence must be 8h, fast, v2-1w or v2-1d' });

    const resBad = await GET(request('?cadence=1h'));
    expect(resBad.status).toBe(400);
    expect(await resBad.json()).toEqual({ error: 'cadence must be 8h, fast, v2-1w or v2-1d' });

    expect(mocks.runLabSignals8h).not.toHaveBeenCalled();
    expect(mocks.runLabSignalsFast).not.toHaveBeenCalled();
    expect(mocks.runLabV2Weekly).not.toHaveBeenCalled();
    expect(mocks.runLabV2Daily).not.toHaveBeenCalled();
    expect(mocks.jobKeys).toEqual(['lab-signals:invalid', 'lab-signals:invalid']);
  });

  it('matches the seven CRON_JOBS entries for /api/cron/lab-signals', async () => {
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
    expect(CRON_JOBS.find((j) => j.job === 'lab-v2-signals:1w')).toMatchObject({
      path: '/api/cron/lab-signals',
      params: { cadence: 'v2-1w' },
      schedule: '3 0 * * 1',
      expectedEverySeconds: 7 * 86400,
      method: 'GET',
    });
    expect(CRON_JOBS.find((j) => j.job === 'lab-v2-signals:1w:retry')).toMatchObject({
      path: '/api/cron/lab-signals',
      params: { cadence: 'v2-1w', attempt: 'retry' },
      schedule: '8 0 * * 1',
      expectedEverySeconds: 7 * 86400,
      method: 'GET',
    });
    expect(CRON_JOBS.find((j) => j.job === 'lab-v2-signals:1d')).toMatchObject({
      path: '/api/cron/lab-signals',
      params: { cadence: 'v2-1d' },
      schedule: '3 0 * * *',
      expectedEverySeconds: 86400,
      method: 'GET',
    });
    expect(CRON_JOBS.find((j) => j.job === 'lab-v2-signals:1d:retry')).toMatchObject({
      path: '/api/cron/lab-signals',
      params: { cadence: 'v2-1d', attempt: 'retry' },
      schedule: '8 0 * * *',
      expectedEverySeconds: 86400,
      method: 'GET',
    });
  });
});
