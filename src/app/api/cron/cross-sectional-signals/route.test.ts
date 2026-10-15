// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  runRvSignal: vi.fn(),
  jobKeys: [] as string[],
}));

vi.mock('@/lib/cron-auth', () => ({ verifyCronSecret: (...a: unknown[]) => mocks.verify(...a) }));
vi.mock('@/lib/signals/cross-sectional/generator', () => ({
  runRvSignal: (...a: unknown[]) => mocks.runRvSignal(...a),
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
  return new NextRequest(new URL(`http://localhost:3000/api/cron/cross-sectional-signals${query}`));
}

const OK = {
  success: true,
  barTime: 1_790_121_600_000,
  created: true,
  skipped: [{ symbol: 'DOTUSDT', reason: 'bars_incomplete' }],
  ranked: [{ symbol: 'BTCUSDT', compositeZ: 1.2, rank: 1 }],
  fetchErrors: [{ symbol: 'DOTUSDT', error: 'HTTP 503' }],
  syncErrors: [],
};

describe('GET /api/cron/cross-sectional-signals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jobKeys.length = 0;
    mocks.verify.mockReturnValue(true);
    mocks.runRvSignal.mockResolvedValue(OK);
  });

  it('returns 401 and never runs the job without the cron secret', async () => {
    mocks.verify.mockReturnValue(false);
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mocks.runRvSignal).not.toHaveBeenCalled();
  });

  it('runs the rv-v1 signal job at the current time and returns its result', async () => {
    const before = Date.now();
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK);
    const [now] = mocks.runRvSignal.mock.calls[0];
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('returns 500 with the engine code when the job cannot score the bar', async () => {
    const failure = {
      success: false,
      barTime: OK.barTime,
      code: 'universe_too_small',
      error: 'universe_too_small: 4 symbols usable, minimum 5 required',
      fetchErrors: [],
      syncErrors: [],
    };
    mocks.runRvSignal.mockResolvedValue(failure);
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(failure);
  });

  it('returns 500 when the job throws', async () => {
    mocks.runRvSignal.mockRejectedValue(new Error('mongo down'));
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'mongo down' });
  });

  it('reports the primary line and the retry line under separate heartbeat keys', async () => {
    const { GET } = await import('./route');
    await GET(request());
    await GET(request('?attempt=retry'));
    expect(mocks.jobKeys).toEqual(['cross-sectional-signals', 'cross-sectional-signals:retry']);
  });

  it('is registered in the cron table under both keys, the retry thirty minutes after the primary', async () => {
    const { CRON_JOBS } = await import('@/lib/cron-jobs');
    expect(CRON_JOBS.find((j) => j.job === 'cross-sectional-signals')).toMatchObject({
      path: '/api/cron/cross-sectional-signals',
      params: {},
      schedule: '1 */8 * * *',
      expectedEverySeconds: 8 * 3600,
    });
    expect(CRON_JOBS.find((j) => j.job === 'cross-sectional-signals:retry')).toMatchObject({
      path: '/api/cron/cross-sectional-signals',
      params: { attempt: 'retry' },
      schedule: '31 */8 * * *',
      expectedEverySeconds: 8 * 3600,
    });
  });
});
