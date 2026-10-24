// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: vi.fn(() => 'mock-limiter'),
  rateLimit: vi.fn(() => null),
}));

vi.mock('@/lib/signals/lab/status-counts', () => ({
  labStatusCounts: vi.fn(),
}));

import { GET } from './route';
import { connectDB } from '@/lib/mongodb';
import { cachedFetch } from '@/lib/redis';
import { rateLimit } from '@/lib/rate-limit';
import { labStatusCounts } from '@/lib/signals/lab/status-counts';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/public/lab-counts');
}

describe('GET /api/public/lab-counts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimit).mockResolvedValue(null);
  });

  it('returns response shape with Cache-Control header', async () => {
    const mockCounts = {
      underTest: 12,
      validated: 0,
      notStarted: 1,
      hypotheses: 13,
      rejectedRules: 1,
      ledgerTrials: 2204,
      asOf: '2026-10-24T12:00:00.000Z',
    };

    vi.mocked(cachedFetch).mockResolvedValue(mockCounts);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=300, stale-while-revalidate=600'
    );

    const data = await res.json();
    expect(data).toEqual(mockCounts);
  });

  it('contains no hypothesis ids anywhere in the JSON response', async () => {
    vi.mocked(cachedFetch).mockResolvedValue({
      underTest: 12,
      validated: 0,
      notStarted: 1,
      hypotheses: 13,
      rejectedRules: 1,
      ledgerTrials: 2204,
      asOf: '2026-10-24T12:00:00.000Z',
    });

    const res = await GET(makeRequest());
    const data = await res.json();
    const rawString = JSON.stringify(data);

    expect(rawString).not.toContain('L1-');
    expect(rawString).not.toContain('S1-');
    expect(rawString).not.toMatch(/L[1-4]-|S[1-2]-|N[2-3]-|F1-/);
  });

  it('returns rate limit response when limited', async () => {
    vi.mocked(rateLimit).mockResolvedValue(
      NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    );

    const res = await GET(makeRequest());
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe('Too many requests');
  });

  it('uses the public-lab-counts cache key with 300 second TTL', async () => {
    vi.mocked(cachedFetch).mockImplementation(async (key, fn, ttl) => {
      expect(key).toBe('public-lab-counts');
      expect(ttl).toBe(300);
      vi.mocked(labStatusCounts).mockResolvedValue({
        underTest: 10,
        validated: 1,
        notStarted: 2,
        hypotheses: 13,
      });
      return fn();
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(connectDB).toHaveBeenCalledTimes(1);
    expect(labStatusCounts).toHaveBeenCalledTimes(1);
    expect(cachedFetch).toHaveBeenCalledWith(
      'public-lab-counts',
      expect.any(Function),
      300
    );

    const data = await res.json();
    expect(data.underTest).toBe(10);
    expect(data.validated).toBe(1);
    expect(data.notStarted).toBe(2);
    expect(data.hypotheses).toBe(13);
    expect(data.rejectedRules).toBe(1);
    expect(data.ledgerTrials).toBe(2204);
    expect(typeof data.asOf).toBe('string');
  });

  it('returns 502 with unavailable error message on error and logs message only', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(cachedFetch).mockRejectedValue(new Error('Database timed out'));

    const res = await GET(makeRequest());
    expect(res.status).toBe(502);

    const data = await res.json();
    expect(data).toEqual({ error: 'Lab counts are unavailable' });

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to fetch public lab counts:',
      'Database timed out'
    );
  });
});
