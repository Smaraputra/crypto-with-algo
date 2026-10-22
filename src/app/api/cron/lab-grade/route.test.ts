// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  runLabGrade: vi.fn(),
  runLabGradeV4: vi.fn(),
  jobKeys: [] as string[],
}));

vi.mock('@/lib/cron-auth', () => ({ verifyCronSecret: (...a: unknown[]) => mocks.verify(...a) }));
vi.mock('@/lib/signals/lab/job-grade', () => ({
  runLabGrade: (...a: unknown[]) => mocks.runLabGrade(...a),
}));
vi.mock('@/lib/signals/lab/job-grade-v4', () => ({
  runLabGradeV4: (...a: unknown[]) => mocks.runLabGradeV4(...a),
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

const OK_V1 = {
  success: true,
  graded: [{ hypothesis: 'L1-8h', barClose: 1_790_121_600_000, bet: true, x: 0.05, b: 0.1, e: 1.05 }],
  pending: [],
  errors: [],
};

const OK_V4 = {
  success: true,
  graded: [{ hypothesis: 'S1-1h', barClose: 1_790_121_600_000, bet: true, x: 0.08, b: 0, e: 1.08 }],
  pending: [],
  errors: [],
};

describe('GET /api/cron/lab-grade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jobKeys.length = 0;
    mocks.verify.mockReturnValue(true);
    mocks.runLabGrade.mockResolvedValue(OK_V1);
    mocks.runLabGradeV4.mockResolvedValue(OK_V4);
  });

  it('returns 401 and never runs the jobs without the cron secret', async () => {
    mocks.verify.mockReturnValue(false);
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.runLabGrade).not.toHaveBeenCalled();
    expect(mocks.runLabGradeV4).not.toHaveBeenCalled();
  });

  it('calls both runLabGrade and runLabGradeV4 and merges their reports on success', async () => {
    const before = Date.now();
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.graded).toEqual([...OK_V1.graded, ...OK_V4.graded]);
    expect(data.pending).toEqual([]);
    expect(data.errors).toEqual([]);

    expect(mocks.runLabGrade).toHaveBeenCalledTimes(1);
    expect(mocks.runLabGradeV4).toHaveBeenCalledTimes(1);

    const [now1] = mocks.runLabGrade.mock.calls[0];
    expect(now1).toBeGreaterThanOrEqual(before);
    expect(now1).toBeLessThanOrEqual(Date.now());

    const [now2] = mocks.runLabGradeV4.mock.calls[0];
    expect(now2).toBeGreaterThanOrEqual(before);
    expect(now2).toBeLessThanOrEqual(Date.now());

    expect(mocks.jobKeys).toEqual(['lab-grade']);
  });

  it('a v4 throw keeps the v1 to v3 result, gives 500, and the error is reported', async () => {
    mocks.runLabGradeV4.mockRejectedValue(new Error('v4 db error'));
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(500);

    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.graded).toEqual(OK_V1.graded);
    expect(data.errors).toEqual(['v4 db error']);
  });

  it('a v1 to v3 failure still runs v4', async () => {
    mocks.runLabGrade.mockRejectedValue(new Error('v1 db connection error'));
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(500);

    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.graded).toEqual(OK_V4.graded);
    expect(data.errors).toEqual(['v1 db connection error']);
    expect(mocks.runLabGradeV4).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when either report has success false', async () => {
    const failureV1 = {
      success: false,
      graded: [],
      pending: [],
      errors: ['price fetch failed'],
    };
    mocks.runLabGrade.mockResolvedValue(failureV1);
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(500);

    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.graded).toEqual(OK_V4.graded);
    expect(data.errors).toEqual(['price fetch failed']);
    expect(mocks.runLabGradeV4).toHaveBeenCalledTimes(1);
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
