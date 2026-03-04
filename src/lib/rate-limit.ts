import { NextRequest, NextResponse } from 'next/server';
import { ioRedisClient } from './redis';

export interface RateLimiter {
  limit(identifier: string): Promise<{
    success: boolean;
    remaining: number;
    reset: number;
  }>;
}

/**
 * Sliding window rate limiter using Redis sorted sets.
 * Lua script ensures atomicity: remove expired entries, count, conditionally add.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < max then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, max - count - 1, now + window}
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset = now + window
  if #oldest >= 2 then
    reset = tonumber(oldest[2]) + window
  end
  return {0, 0, reset}
end
`;

export function createRateLimiter(
  maxRequests: number,
  windowSeconds: number
): RateLimiter | null {
  if (!ioRedisClient) return null;

  const client = ioRedisClient;
  const windowMs = windowSeconds * 1000;

  return {
    async limit(identifier: string) {
      const now = Date.now();
      const key = `ratelimit:${identifier}`;
      const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;

      const result = (await client.eval(
        SLIDING_WINDOW_LUA,
        1,
        key,
        now,
        windowMs,
        maxRequests,
        member
      )) as [number, number, number];

      return {
        success: result[0] === 1,
        remaining: result[1],
        reset: result[2],
      };
    },
  };
}

export async function rateLimit(
  req: NextRequest,
  limiter: RateLimiter | null,
  options?: { failClosed?: boolean }
): Promise<NextResponse | null> {
  if (!limiter) {
    // Redis not configured at all -- allow the request through.
    // failClosed only applies to runtime Redis errors, not missing config.
    return null;
  }

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1';

  try {
    const { success, remaining, reset } = await limiter.limit(ip);

    if (!success) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: {
            'X-RateLimit-Remaining': remaining.toString(),
            'X-RateLimit-Reset': reset.toString(),
          },
        }
      );
    }
  } catch (error) {
    console.error('Rate limiter Redis error:', error);
    if (options?.failClosed) {
      return NextResponse.json(
        { error: 'Service temporarily unavailable' },
        { status: 503 }
      );
    }
  }

  return null;
}

/**
 * Shared rate limiter for authenticated user-data endpoints.
 * 60 requests per 60 seconds, keyed by userId.
 */
export const authenticatedLimiter = createRateLimiter(60, 60);

/**
 * Rate-limit by user ID (for authenticated endpoints).
 * Fails open on Redis errors (allows request through).
 */
export async function rateLimitUser(
  userId: string,
  limiter: RateLimiter | null
): Promise<NextResponse | null> {
  if (!limiter) return null;

  try {
    const { success, remaining, reset } = await limiter.limit(userId);

    if (!success) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: {
            'X-RateLimit-Remaining': remaining.toString(),
            'X-RateLimit-Reset': reset.toString(),
          },
        }
      );
    }
  } catch (error) {
    console.error('Rate limiter Redis error:', error);
    // Fail open for authenticated endpoints -- Redis outage should not block users
  }

  return null;
}
