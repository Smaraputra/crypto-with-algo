// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockVerify = vi.fn();
const mockConnectDB = vi.fn();
const mockRunPaperDesk = vi.fn();

vi.mock('@/lib/cron-auth', () => ({ verifyCronSecret: (...a: unknown[]) => mockVerify(...a) }));
vi.mock('@/lib/mongodb', () => ({ connectDB: () => mockConnectDB() }));
vi.mock('@/lib/paper-desk/run', () => ({ runPaperDesk: (...a: unknown[]) => mockRunPaperDesk(...a) }));
// withJobRun records a heartbeat against the registry; the route's own
// behaviour is what matters here, so it passes through.
vi.mock('@/lib/job-run', () => ({
  withJobRun: (_job: string, handler: unknown) => handler,
}));

function request(): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/cron/paper-desk'));
}

const REPORT = {
  books: [
    {
      book: 'day_trading:1h',
      bars: 2,
      symbols: 10,
      opened: 1,
      closed: 1,
      missingScoreBars: 0,
      pendingBars: 0,
      skippedEntries: 0,
      capped: false,
      cursor: 1_700_000_000_000,
    },
  ],
  opened: 1,
  closed: 1,
  leasedOut: 0,
  errors: 0,
};

describe('GET /api/cron/paper-desk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerify.mockReturnValue(true);
    mockConnectDB.mockResolvedValue(undefined);
    mockRunPaperDesk.mockResolvedValue(REPORT);
  });

  it('returns 401 and never runs the desk without the cron secret', async () => {
    mockVerify.mockReturnValue(false);
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mockRunPaperDesk).not.toHaveBeenCalled();
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('runs the desk and returns its per-book report', async () => {
    const { GET } = await import('./route');
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(mockConnectDB).toHaveBeenCalled();
    expect(await res.json()).toEqual({
      opened: 1,
      closed: 1,
      leasedOut: 0,
      errors: 0,
      books: REPORT.books,
    });
  });

  it('is registered in the cron table under the key the route reports heartbeats as', async () => {
    const { CRON_JOBS } = await import('@/lib/cron-jobs');
    const spec = CRON_JOBS.find((j) => j.job === 'paper-desk');
    expect(spec).toMatchObject({
      path: '/api/cron/paper-desk',
      schedule: '*/1 * * * *',
      expectedEverySeconds: 60,
      method: 'GET',
    });
    // A desk that ran less often than the quickest book would skip bars.
    expect(spec!.expectedEverySeconds).toBeLessThanOrEqual(60);
  });
});
