// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { recordJobRun, withJobRun } from './job-run';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

const updateOne = vi.hoisted(() => vi.fn());
vi.mock('@/lib/models/job-heartbeat', () => ({ JobHeartbeat: { updateOne } }));

function request(url = 'http://localhost:3000/api/cron/thing'): NextRequest {
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  updateOne.mockResolvedValue({ acknowledged: true });
});

describe('recordJobRun', () => {
  it('records a success and clears the consecutive failure count', async () => {
    await recordJobRun('resolve-outcomes', { ok: true, durationMs: 12, result: { resolved: 3 } });

    const [filter, update, options] = updateOne.mock.calls[0];
    expect(filter).toEqual({ job: 'resolve-outcomes' });
    expect(options).toEqual({ upsert: true });
    expect(update.$set.lastStatus).toBe('success');
    expect(update.$set.consecutiveFailures).toBe(0);
    expect(update.$set.lastResult).toEqual({ resolved: 3 });
    expect(update.$set.lastSuccessAt).toBeInstanceOf(Date);
    expect(update.$inc).toEqual({ runCount: 1 });
  });

  it('leaves lastError and lastFailureAt untouched on success', async () => {
    // A success must not erase the evidence of the failure before it.
    await recordJobRun('resolve-outcomes', { ok: true, durationMs: 1 });

    const [, update] = updateOne.mock.calls[0];
    expect(update.$set).not.toHaveProperty('lastError');
    expect(update.$set).not.toHaveProperty('lastFailureAt');
  });

  it('records a failure and increments the failure counters', async () => {
    await recordJobRun('ingest-perp', { ok: false, durationMs: 9, error: 'archive 500' });

    const [, update] = updateOne.mock.calls[0];
    expect(update.$set.lastStatus).toBe('failure');
    expect(update.$set.lastError).toBe('archive 500');
    expect(update.$set.lastFailureAt).toBeInstanceOf(Date);
    expect(update.$inc).toEqual({ runCount: 1, failureCount: 1, consecutiveFailures: 1 });
  });

  it('falls back to a placeholder when a failure carries no message', async () => {
    await recordJobRun('ingest-perp', { ok: false, durationMs: 1 });

    expect(updateOne.mock.calls[0][1].$set.lastError).toBe('unknown error');
  });

  it('never throws when the write fails', async () => {
    // Observability that can 500 a live cron route is worse than none.
    updateOne.mockRejectedValue(new Error('mongo down'));

    await expect(recordJobRun('check-alerts', { ok: true, durationMs: 1 })).resolves.toBeUndefined();
  });
});

describe('withJobRun', () => {
  it('returns the handler\'s own response object, not a reconstruction', async () => {
    // The riskiest property of the wrapper: it sits on every live cron route,
    // and rebuilding the response would drop headers while still returning 200
    // to wget, making the breakage invisible in the cron log.
    const res = NextResponse.json({ synced: 10 });
    const wrapped = withJobRun('sync-candles:standard', async () => res);

    const returned = await wrapped(request());

    expect(returned).toBe(res);
    expect(await returned.json()).toEqual({ synced: 10 });
  });

  it('records the response body as the run result', async () => {
    const wrapped = withJobRun('sync-candles:standard', async () =>
      NextResponse.json({ synced: 10, errors: 0 })
    );

    await wrapped(request());

    expect(updateOne.mock.calls[0][1].$set.lastResult).toEqual({ synced: 10, errors: 0 });
    expect(updateOne.mock.calls[0][1].$set.lastStatus).toBe('success');
  });

  it('writes nothing on a 401', async () => {
    // An unauthenticated probe must not be able to forge a heartbeat, and a
    // wrong secret is not the job failing.
    const wrapped = withJobRun('check-alerts', async () =>
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const res = await wrapped(request());

    expect(res.status).toBe(401);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('treats any other 4xx as a failure and keeps the body error', async () => {
    const wrapped = withJobRun('ingest-perp', async () =>
      NextResponse.json({ error: 'Invalid interval parameter' }, { status: 400 })
    );

    await wrapped(request());

    const [, update] = updateOne.mock.calls[0];
    expect(update.$set.lastStatus).toBe('failure');
    expect(update.$set.lastError).toBe('Invalid interval parameter');
  });

  it('falls back to the status code when an error response has no error field', async () => {
    const wrapped = withJobRun('ingest-perp', async () => new NextResponse(null, { status: 500 }));

    await wrapped(request());

    expect(updateOne.mock.calls[0][1].$set.lastError).toBe('HTTP 500');
  });

  it('records a throw as a failure and rethrows it', async () => {
    const wrapped = withJobRun('resolve-outcomes', async () => {
      throw new Error('mongo timeout');
    });

    await expect(wrapped(request())).rejects.toThrow('mongo timeout');

    const [, update] = updateOne.mock.calls[0];
    expect(update.$set.lastStatus).toBe('failure');
    expect(update.$set.lastError).toBe('mongo timeout');
  });

  it('derives the job key from the request', async () => {
    // Four routes are scheduled several times with different params; each line
    // needs its own key or the slow one masks the fast one dying.
    const wrapped = withJobRun(
      (req) => `sync-candles:${req.nextUrl.searchParams.get('intervals') ?? 'standard'}`,
      async () => NextResponse.json({ synced: 1 })
    );

    await wrapped(request('http://localhost:3000/api/cron/sync-candles?intervals=1m'));
    expect(updateOne.mock.calls[0][0]).toEqual({ job: 'sync-candles:1m' });

    await wrapped(request('http://localhost:3000/api/cron/sync-candles'));
    expect(updateOne.mock.calls[1][0]).toEqual({ job: 'sync-candles:standard' });
  });

  it('still returns the response when the heartbeat write fails', async () => {
    updateOne.mockRejectedValue(new Error('mongo down'));
    const wrapped = withJobRun('check-alerts', async () => NextResponse.json({ evaluated: 0 }));

    const res = await wrapped(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ evaluated: 0 });
  });

  it('tolerates a non-JSON response body', async () => {
    const wrapped = withJobRun('check-alerts', async () => new NextResponse('ok', { status: 200 }));

    await wrapped(request());

    expect(updateOne.mock.calls[0][1].$set.lastStatus).toBe('success');
    expect(updateOne.mock.calls[0][1].$set.lastResult).toBeNull();
  });
});
