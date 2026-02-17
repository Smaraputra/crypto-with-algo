// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockEval } = vi.hoisted(() => ({
  mockEval: vi.fn(),
}));

vi.mock('./redis', () => ({
  ioRedisClient: { eval: mockEval },
}));

import { createRateLimiter, rateLimit } from './rate-limit';

beforeEach(() => {
  mockEval.mockReset();
});

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/test', { headers });
}

describe('createRateLimiter', () => {
  it('returns null when ioRedisClient is null', async () => {
    vi.doMock('./redis', () => ({ ioRedisClient: null }));
    vi.resetModules();
    const { createRateLimiter: create } = await import('./rate-limit');
    const limiter = create(10, 10);
    expect(limiter).toBeNull();
    // Restore for subsequent tests
    vi.doMock('./redis', () => ({ ioRedisClient: { eval: mockEval } }));
    vi.resetModules();
  });

  it('returns a limiter with limit method when ioRedisClient exists', () => {
    const limiter = createRateLimiter(10, 10);
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
    mockEval.mockResolvedValue([1, 9, Date.now() + 10000]);
    const limiter = createRateLimiter(10, 10)!;
    const result = await rateLimit(makeRequest(), limiter);
    expect(result).toBeNull();
  });

  it('returns 429 response when over rate limit', async () => {
    const resetTime = Date.now() + 10000;
    mockEval.mockResolvedValue([0, 0, resetTime]);
    const limiter = createRateLimiter(10, 10)!;
    const result = await rateLimit(makeRequest(), limiter);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    expect(result!.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(result!.headers.get('X-RateLimit-Reset')).toBe(resetTime.toString());
    const body = await result!.json();
    expect(body.error).toBe('Too many requests. Please try again later.');
  });

  it('extracts IP from x-forwarded-for header', async () => {
    mockEval.mockResolvedValue([1, 9, Date.now()]);
    const limiter = createRateLimiter(10, 10)!;
    await rateLimit(makeRequest({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), limiter);

    // The key argument should contain the IP
    const evalArgs = mockEval.mock.calls[0];
    const key = evalArgs[2]; // KEYS[1]
    expect(key).toBe('ratelimit:1.2.3.4');
  });

  it('uses 127.0.0.1 as fallback IP', async () => {
    mockEval.mockResolvedValue([1, 9, Date.now()]);
    const limiter = createRateLimiter(10, 10)!;
    await rateLimit(makeRequest(), limiter);

    const evalArgs = mockEval.mock.calls[0];
    const key = evalArgs[2]; // KEYS[1]
    expect(key).toBe('ratelimit:127.0.0.1');
  });

  it('allows request through on eval error', async () => {
    mockEval.mockRejectedValue(new Error('Redis down'));
    const limiter = createRateLimiter(10, 10)!;
    const result = await rateLimit(makeRequest(), limiter);
    expect(result).toBeNull();
  });

  describe('failClosed option', () => {
    it('returns null when limiter is null even with failClosed (no Redis configured)', async () => {
      const result = await rateLimit(makeRequest(), null, { failClosed: true });
      expect(result).toBeNull();
    });

    it('returns 503 on Redis error when failClosed is true', async () => {
      mockEval.mockRejectedValue(new Error('Redis down'));
      const limiter = createRateLimiter(10, 10)!;
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await rateLimit(makeRequest(), limiter, { failClosed: true });

      expect(result).not.toBeNull();
      expect(result!.status).toBe(503);
      expect(consoleSpy).toHaveBeenCalledWith(
        'Rate limiter Redis error:',
        expect.any(Error)
      );
      consoleSpy.mockRestore();
    });

    it('allows request on Redis error when failClosed is not set', async () => {
      mockEval.mockRejectedValue(new Error('Redis down'));
      const limiter = createRateLimiter(10, 10)!;
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await rateLimit(makeRequest(), limiter);
      expect(result).toBeNull();

      vi.restoreAllMocks();
    });

    it('logs error on Redis failure', async () => {
      mockEval.mockRejectedValue(new Error('Connection refused'));
      const limiter = createRateLimiter(10, 10)!;
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await rateLimit(makeRequest(), limiter);

      expect(consoleSpy).toHaveBeenCalledWith(
        'Rate limiter Redis error:',
        expect.objectContaining({ message: 'Connection refused' })
      );
      consoleSpy.mockRestore();
    });
  });
});
