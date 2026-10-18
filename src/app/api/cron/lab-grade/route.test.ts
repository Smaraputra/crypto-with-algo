// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  runLabGrade: vi.fn(),
  jobKeys: [] as string[],
}));

vi.mock('@/lib/cron-auth', () => ({ verifyCronSecret: (...a: unknown[]) => mocks.verify(...a) }));
vi.mock('@/lib/signals/lab/job-grade', () => ({
  runLabGrade: (...a: unknown[]) => mocks.runLabGrade(...a),
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

function request(): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/cron/lab-grade'));
}

const OK = {
  success: true,
  graded: [{ hypothesis: 'L1-8h', barClose: 1_790_121_600_000, bet: true, x: 0.05, b: 0.1, e: 1.05 }],
  pending: [],
  errors: [],
};

describe('GET /api/cron/lab-grade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jobKeys.length = 0;
    mocks.verify.mockReturnValue(true);
    mocks.runLabGrade.mockResolvedValue(OK);
  });

  it('returns 401 and never runs the job without the cron secret', async () => {
    mocks.verify.mockReturnValue(false);
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.runLabGrade).not.toHaveBeenCalled();
  });

  it('runs runLabGrade and answers 200 with key lab-grade on success', async () => {
    const before = Date.now();
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK);
    expect(mocks.runLabGrade).toHaveBeenCalledTimes(1);
    const [now] = mocks.runLabGrade.mock.calls[0];
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(mocks.jobKeys).toEqual(['lab-grade']);
  });

  it('returns 500 when success is false', async () => {
    const failure = {
      success: false,
      graded: [],
      pending: [],
      errors: ['price fetch failed'],
    };
    mocks.runLabGrade.mockResolvedValue(failure);
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(failure);
  });

  it('returns 500 with error message when runLabGrade throws', async () => {
    mocks.runLabGrade.mockRejectedValue(new Error('db connection error'));
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'db connection error' });
  });

  it('matches the CRON_JOBS entry for /api/cron/lab-grade', async () => {
    const { CRON_JOBS } = await import('@/lib/cron-jobs');
    expect(CRON_JOBS.find((j) => j.job === 'lab-grade')).toMatchObject({
      path: '/api/cron/lab-grade',
      params: {},
      schedule: '20 * * * *',
      expectedEverySeconds: 3600,
      method: 'GET',
    });
  });
});
