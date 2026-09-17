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
});
