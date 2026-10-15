// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  runRvDesk: vi.fn(),
}));

vi.mock('@/lib/cron-auth', () => ({ verifyCronSecret: (...a: unknown[]) => mocks.verify(...a) }));
vi.mock('@/lib/paper-desk/rv-desk', () => ({ runRvDesk: (...a: unknown[]) => mocks.runRvDesk(...a) }));
vi.mock('@/lib/job-run', () => ({
  withJobRun: (_job: string, handler: unknown) => handler,
}));

function request(): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/cron/cross-sectional-paper'));
}

const STEPPED = {
  leased: true,
  stepped: 1,
  adopted: 0,
  pending: [],
  cursor: 1_790_121_600_000,
  waiting: 0,
  capped: false,
  stalePending: false,
};

describe('GET /api/cron/cross-sectional-paper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockReturnValue(true);
    mocks.runRvDesk.mockResolvedValue(STEPPED);
  });

  it('returns 401 and never runs the desk without the cron secret', async () => {
    mocks.verify.mockReturnValue(false);
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mocks.runRvDesk).not.toHaveBeenCalled();
  });

  it('runs the rv-v1 desk at the current time under a fresh owner and returns its report', async () => {
    const before = Date.now();
    const { GET } = await import('./route');
    const res = await GET(request());
    await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, ...STEPPED });
    const [[now, owner], [, owner2]] = mocks.runRvDesk.mock.calls;
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(owner).toMatch(/^[0-9a-f-]{36}$/);
    expect(owner2).not.toBe(owner);
  });

  it('answers 200 when another run holds the lease', async () => {
    mocks.runRvDesk.mockResolvedValue({ leased: false, stepped: 0 });
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, leased: false, stepped: 0 });
  });

  it('answers 200 for a step pending less than one cadence', async () => {
    mocks.runRvDesk.mockResolvedValue({
      ...STEPPED,
      stepped: 0,
      pending: [{ barTime: 1_790_150_400_000, reasons: ['funding_missing:ETHUSDT'] }],
    });
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(200);
  });

  it('answers 500 once a step has been pending for more than one cadence', async () => {
    const report = {
      ...STEPPED,
      stepped: 0,
      pending: [{ barTime: 1_790_150_400_000, reasons: ['held_symbol_unscored: ETHUSDT is held but missing from the ranking'] }],
      stalePending: true,
    };
    mocks.runRvDesk.mockResolvedValue(report);
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, ...report });
    expect(body.error).toMatch(/pending for more than one cadence: held_symbol_unscored/);
  });

  it('answers 500 when the desk throws', async () => {
    mocks.runRvDesk.mockRejectedValue(new Error('rv desk: lease lost by x before the book could be written'));
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'rv desk: lease lost by x before the book could be written' });
  });

  it('is scheduled at 01:05, 09:05 and 17:05 UTC, after the first fill hour closes', async () => {
    const { CRON_JOBS } = await import('@/lib/cron-jobs');
    expect(CRON_JOBS.find((j) => j.job === 'cross-sectional-paper')).toMatchObject({
      path: '/api/cron/cross-sectional-paper',
      params: {},
      schedule: '5 1-23/8 * * *',
      expectedEverySeconds: 8 * 3600,
    });
  });
});
