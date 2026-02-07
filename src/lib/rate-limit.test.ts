// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockLimit = vi.fn();

vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.limit = mockLimit;
  }) as ReturnType<typeof vi.fn> & { slidingWindow: ReturnType<typeof vi.fn> };
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue('sliding-window-algo');
  return { Ratelimit: RatelimitMock };
});

vi.mock('./redis', () => ({
  redis: { fake: true },
}));

import { createRateLimiter, rateLimit } from './rate-limit';

beforeEach(() => {
  mockLimit.mockReset();
});

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/test', { headers });
}

describe('createRateLimiter', () => {
  it('returns null when redis is null', async () => {
    vi.doMock('./redis', () => ({ redis: null }));
    vi.resetModules();
    const { createRateLimiter: create } = await import('./rate-limit');
    const limiter = create(10, '10 s');
    expect(limiter).toBeNull();
    // Restore for subsequent tests
    vi.doMock('./redis', () => ({ redis: { fake: true } }));
    vi.resetModules();
  });

  it('returns a Ratelimit instance when redis exists', () => {
    const limiter = createRateLimiter(10, '10 s');
    expect(limiter).not.toBeNull();
    expect(limiter).toHaveProperty('limit');
  });
});

describe('rateLimit', () => {
  it('returns null when limiter is null', async () => {
    const result = await rateLimit(makeRequest(), null);
    expect(result).toBeNull();
  });

  it('returns null when under rate limit', async () => {
    mockLimit.mockResolvedValue({ success: true, remaining: 9, reset: Date.now() + 10000 });
    const limiter = createRateLimiter(10, '10 s')!;
    const result = await rateLimit(makeRequest(), limiter);
    expect(result).toBeNull();
  });

  it('returns 429 response when over rate limit', async () => {
    const resetTime = Date.now() + 10000;
    mockLimit.mockResolvedValue({ success: false, remaining: 0, reset: resetTime });
    const limiter = createRateLimiter(10, '10 s')!;
    const result = await rateLimit(makeRequest(), limiter);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    expect(result!.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(result!.headers.get('X-RateLimit-Reset')).toBe(resetTime.toString());
    const body = await result!.json();
    expect(body.error).toBe('Too many requests. Please try again later.');
  });

  it('extracts IP from x-forwarded-for header', async () => {
    mockLimit.mockResolvedValue({ success: true, remaining: 9, reset: Date.now() });
    const limiter = createRateLimiter(10, '10 s')!;
    await rateLimit(makeRequest({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), limiter);

    expect(mockLimit).toHaveBeenCalledWith('1.2.3.4');
  });

  it('uses 127.0.0.1 as fallback IP', async () => {
    mockLimit.mockResolvedValue({ success: true, remaining: 9, reset: Date.now() });
    const limiter = createRateLimiter(10, '10 s')!;
    await rateLimit(makeRequest(), limiter);

    expect(mockLimit).toHaveBeenCalledWith('127.0.0.1');
  });

  it('allows request through on limiter.limit() error', async () => {
    mockLimit.mockRejectedValue(new Error('Redis down'));
    const limiter = createRateLimiter(10, '10 s')!;
    const result = await rateLimit(makeRequest(), limiter);
    expect(result).toBeNull();
  });
});
