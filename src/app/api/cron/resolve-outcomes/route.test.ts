// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

const mockResolveDueOutcomes = vi.fn();

vi.mock('@/lib/signals/outcome-resolver', () => ({
  resolveDueOutcomes: (...args: unknown[]) => mockResolveDueOutcomes(...args),
}));

// The route is wrapped by withJobRun, which upserts a heartbeat after the
// handler returns. Mock the MODEL rather than the wrapper, so the wrapper's
// real logic still runs here and these tests double as its integration cover.
// Without this, mongoose buffers the write against an unconnected client and
// the test hangs until bufferTimeoutMS.
const mockHeartbeatUpdate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/models/job-heartbeat', () => ({
  JobHeartbeat: { updateOne: mockHeartbeatUpdate },
}));

import { GET } from './route';

function makeRequest(secret?: string): NextRequest {
  const url = new URL('http://localhost/api/cron/resolve-outcomes');
  const headers: Record<string, string> = {};
  if (secret) headers.authorization = `Bearer ${secret}`;
  return new NextRequest(url, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', 'test-secret');
  mockHeartbeatUpdate.mockResolvedValue({ acknowledged: true });
});

describe('GET /api/cron/resolve-outcomes', () => {
  it('returns 401 without cron secret', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockResolveDueOutcomes).not.toHaveBeenCalled();
  });

  it('returns 401 with wrong secret', async () => {
    const res = await GET(makeRequest('wrong-secret'));
    expect(res.status).toBe(401);
  });

  it('returns the resolver counts on success', async () => {
    mockResolveDueOutcomes.mockResolvedValue({ resolved: 5, unresolvable: 1, pending: 42 });

    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data).toEqual({ resolved: 5, unresolvable: 1, pending: 42 });
    expect(mockResolveDueOutcomes).toHaveBeenCalledTimes(1);
  });

  it('records a heartbeat carrying the run counts', async () => {
    mockResolveDueOutcomes.mockResolvedValue({ resolved: 5, unresolvable: 1, pending: 42 });

    await GET(makeRequest('test-secret'));

    const [filter, update] = mockHeartbeatUpdate.mock.calls[0];
    expect(filter).toEqual({ job: 'resolve-outcomes' });
    expect(update.$set.lastStatus).toBe('success');
    expect(update.$set.lastResult).toEqual({ resolved: 5, unresolvable: 1, pending: 42 });
  });

  it('records no heartbeat for an unauthorised request', async () => {
    await GET(makeRequest('wrong-secret'));

    expect(mockHeartbeatUpdate).not.toHaveBeenCalled();
  });
});
